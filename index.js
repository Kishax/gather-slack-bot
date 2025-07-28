require("dotenv").config();
const { Game } = require("@gathertown/gather-game-client");
const axios = require("axios");
const http = require("http");

// AWS SDK for Secrets Manager (App Runner用)
let AWS;
try {
	AWS = require("aws-sdk");
} catch (error) {
	console.log("i AWS SDK not available, using environment variables");
}

class GatherSlackBot {
	constructor() {
		this.game = null;
		this.connectedUsers = new Set();
		this.userNameCache = new Map(); // ユーザー名をキャッシュ
		this.initialUsersLoaded = false; // 初期ユーザー読み込み完了フラグ
		this.pendingEvents = []; // 初期ロード中に受信したイベントを保存
		this.processedJoinEvents = new Set(); // 処理済み参加イベントを追跡（重複回避）
		this.connectionCheckInterval = null; // 定期接続チェック用
		// 初期環境変数の処理（JSONオブジェクトの場合があるため）
		this.slackWebhookUrl = this.parseEnvValue(process.env.SLACK_WEBHOOK_URL);
		this.gatherApiKey = this.parseEnvValue(process.env.GATHER_API_KEY);
		this.gatherSpaceId = this.parseEnvValue(process.env.GATHER_SPACE_ID);

		// 設定チェック
		if (!this.slackWebhookUrl || !this.gatherApiKey || !this.gatherSpaceId) {
			console.log(
				"! 一部の環境変数が設定されていません。Secrets Managerから取得を試行します。",
			);
		}

		console.log("🔧 設定確認:");
		console.log(`- Space ID: ${this.gatherSpaceId || "未設定"}`);
		console.log(`- API Key: ${this.gatherApiKey ? "設定済み" : "未設定"}`);
		console.log(
			`- Slack Webhook: ${this.slackWebhookUrl ? "設定済み" : "未設定"}`,
		);
		console.log(`- Node.js Version: ${process.version}`);
		console.log(`- Environment: ${process.env.NODE_ENV || "development"}`);
		console.log(`- AWS Region: ${process.env.AWS_REGION || "not set"}`);
	}

	// 環境変数値を解析（JSONオブジェクトの場合は適切に処理）
	parseEnvValue(value) {
		if (!value) return null;
		
		// JSONオブジェクトとして解析を試行
		try {
			const parsed = JSON.parse(value);
			if (typeof parsed === 'object' && parsed !== null) {
				console.log("⚠️  環境変数がJSONオブジェクトです。正しい値を抽出します。");
				return null; // Secrets Managerから正しい値を取得する
			}
		} catch (e) {
			// JSON解析失敗は正常（通常の文字列値）
		}
		
		return value;
	}

	// AWS Secrets Managerから環境変数を取得
	async loadSecretsFromAWS() {
		if (!AWS || !process.env.AWS_REGION) {
			console.log(
				"i AWS SDK または AWS_REGION が設定されていません。環境変数を使用します。",
			);
			return;
		}

		try {
			console.log("🔒 AWS Secrets Managerから設定を取得中...");

			const secretsManager = new AWS.SecretsManager({
				region: process.env.AWS_REGION,
			});

			const result = await secretsManager
				.getSecretValue({
					SecretId: "gather-bot-apprunner-secrets",
				})
				.promise();

			const secrets = JSON.parse(result.SecretString);

			console.log("🔍 取得したSecrets:", Object.keys(secrets));

			// 環境変数に設定（文字列として確実に取得）
			if (secrets.GATHER_API_KEY) this.gatherApiKey = String(secrets.GATHER_API_KEY);
			if (secrets.GATHER_SPACE_ID) this.gatherSpaceId = String(secrets.GATHER_SPACE_ID);
			if (secrets.SLACK_WEBHOOK_URL) this.slackWebhookUrl = String(secrets.SLACK_WEBHOOK_URL);

			// プロセス環境変数も更新
			process.env.GATHER_API_KEY = this.gatherApiKey;
			process.env.GATHER_SPACE_ID = this.gatherSpaceId;
			process.env.SLACK_WEBHOOK_URL = this.slackWebhookUrl;

			console.log("✅ Secrets Manager から設定を取得しました");
		} catch (error) {
			console.error("❌ Secrets Manager エラー:", error.message);
			console.log("i 環境変数を使用します");
		}
	}

	// 設定の最終確認
	validateConfiguration() {
		if (!this.slackWebhookUrl || !this.gatherApiKey || !this.gatherSpaceId) {
			const missing = [];
			if (!this.gatherApiKey) missing.push("GATHER_API_KEY");
			if (!this.gatherSpaceId) missing.push("GATHER_SPACE_ID");
			if (!this.slackWebhookUrl) missing.push("SLACK_WEBHOOK_URL");

			throw new Error(
				`必要な環境変数が設定されていません: ${missing.join(", ")}`,
			);
		}

		console.log("✅ 設定確認完了");
	}
	async sendSlackNotification(message, color = "#36a64f") {
		try {
			// URL検証
			if (!this.slackWebhookUrl || !this.slackWebhookUrl.startsWith('https://hooks.slack.com/')) {
				console.error("❌ 無効なSlack Webhook URL:", this.slackWebhookUrl);
				return false;
			}
			const payload = {
				username: "Gather Bot",
				icon_emoji: ":office:",
				attachments: [
					{
						color: color,
						text: message,
						mrkdwn_in: ["text"],
						footer: "Gather Town",
						ts: Math.floor(Date.now() / 1000),
					},
				],
			};

			const response = await axios.post(this.slackWebhookUrl, payload, {
				timeout: 10000,
				headers: {
					"Content-Type": "application/json",
				},
			});

			console.log(`✅ Slack通知送信成功: ${message}`);
			return response.status === 200;
		} catch (error) {
			console.error("❌ Slack通知送信エラー:", error.message);
			return false;
		}
	}

	// ユーザー名を取得（複数の方法を試行）
	async getUserName(playerId, data = null, context = null, isRetry = false) {
		// キャッシュから取得
		if (this.userNameCache.has(playerId)) {
			const cachedName = this.userNameCache.get(playerId);
			console.log(
				`🔍 キャッシュからユーザー名取得: ${cachedName} (ID: ${playerId})`,
			);
			return { name: cachedName, isDelayed: false };
		}

		let playerName = null;
		console.log(`🔍 ユーザー名取得開始 (ID: ${playerId})`);

		// 方法1: ゲームオブジェクトから取得
		try {
			const player = this.game.getPlayer(playerId);
			console.log(`📊 getPlayer結果:`, player);
			if (player && player.name && player.name.trim() !== "") {
				playerName = player.name.trim();
				console.log(`✅ getPlayerから取得: ${playerName}`);
			}
		} catch (error) {
			console.log("i getPlayer失敗:", error.message);
		}

		// 方法2: players配列から取得
		if (!playerName && this.game.players) {
			console.log(`📊 game.players:`, Object.keys(this.game.players));
			if (this.game.players[playerId]) {
				const playerData = this.game.players[playerId];
				console.log(`📊 playerData:`, playerData);
				if (playerData.name && playerData.name.trim() !== "") {
					playerName = playerData.name.trim();
					console.log(`✅ game.playersから取得: ${playerName}`);
				}
			}
		}

		// 方法3: contextのplayerから取得
		if (!playerName && context && context.player) {
			console.log(`📊 context.player:`, context.player);
			if (context.player.name && context.player.name.trim() !== "") {
				playerName = context.player.name.trim();
				console.log(`✅ context.playerから取得: ${playerName}`);
			}
		}

		// 方法4: イベントデータから取得
		if (!playerName && data) {
			console.log(`📊 eventData:`, data);
			if (data.name && data.name.trim() !== "") {
				playerName = data.name.trim();
				console.log(`✅ eventDataから取得: ${playerName}`);
			}
		}

		// 方法5: contextから取得
		if (!playerName && context) {
			console.log(`📊 context:`, context);
			if (context.name && context.name.trim() !== "") {
				playerName = context.name.trim();
				console.log(`✅ contextから取得: ${playerName}`);
			}
		}

		// 方法6: 全プレイヤーから検索
		if (!playerName && this.game.players) {
			console.log("🔍 全プレイヤーから検索...");
			for (const [pid, pdata] of Object.entries(this.game.players)) {
				if (pid === playerId && pdata.name && pdata.name.trim() !== "") {
					playerName = pdata.name.trim();
					console.log(`✅ 全プレイヤー検索で発見: ${playerName}`);
					break;
				}
			}
		}

		// 即座に名前が見つかった場合
		if (playerName) {
			console.log(`✅ 即座に取得した名前: ${playerName} (ID: ${playerId})`);
			this.userNameCache.set(playerId, playerName);
			return { name: playerName, isDelayed: false };
		}

		// 名前が見つからない場合の遅延取得（初回のみ）
		if (!isRetry) {
			console.log("⏳ 遅延取得を試行...");

			// 遅延取得を Promise で実行
			return new Promise((resolve) => {
				setTimeout(async () => {
					try {
						const delayedPlayer = this.game.getPlayer(playerId);
						if (
							delayedPlayer &&
							delayedPlayer.name &&
							delayedPlayer.name.trim() !== ""
						) {
							const delayedName = delayedPlayer.name.trim();
							this.userNameCache.set(playerId, delayedName);
							console.log(`✅ 遅延取得成功: ${delayedName} (ID: ${playerId})`);

							// 遅延取得で正しい名前が見つかった場合の通知は呼び出し元で処理
							resolve({ name: delayedName, isDelayed: true });
						} else {
							console.log(
								`! 遅延取得でも名前が見つかりません (ID: ${playerId})`,
							);
							const fallbackName = "新しいユーザー";
							this.userNameCache.set(playerId, fallbackName);
							resolve({ name: fallbackName, isDelayed: true });
						}
					} catch (error) {
						console.log("i 遅延取得失敗:", error.message);
						const fallbackName = "新しいユーザー";
						this.userNameCache.set(playerId, fallbackName);
						resolve({ name: fallbackName, isDelayed: true });
					}
				}, 1500); // 1.5秒待つ
			});
		}

		// デフォルト値
		const fallbackName = "新しいユーザー";
		console.log(
			`! ユーザー名取得失敗、デフォルト値を使用: ${fallbackName} (ID: ${playerId})`,
		);
		this.userNameCache.set(playerId, fallbackName);
		return { name: fallbackName, isDelayed: false };
	}

	// 定期的な接続状態チェックを開始
	startConnectionMonitoring() {
		if (this.connectionCheckInterval) {
			clearInterval(this.connectionCheckInterval);
		}

		console.log("🔍 定期接続状態チェックを開始（30秒間隔）");
		this.connectionCheckInterval = setInterval(async () => {
			await this.checkConnectionStatus();
		}, 30000); // 30秒ごと
	}

	// 接続状態をチェックして退出を検出
	async checkConnectionStatus() {
		try {
			console.log("🔍 定期接続状態チェック実行中...");

			if (!this.game || !this.game.players) {
				console.log("! ゲームオブジェクトまたはプレイヤー情報が利用できません");
				return;
			}

			const currentPlayers = new Set(Object.keys(this.game.players));
			const trackedUsers = new Set(this.connectedUsers);

			console.log(
				`📊 現在のプレイヤー: [${Array.from(currentPlayers).join(", ")}]`,
			);
			console.log(
				`📊 追跡中のユーザー: [${Array.from(trackedUsers).join(", ")}]`,
			);

			// 追跡中だが実際にはいないユーザー（退出した可能性）
			for (const userId of trackedUsers) {
				if (!currentPlayers.has(userId)) {
					console.log(`🔍 退出を検出: ${userId}`);

					// 退出処理
					this.connectedUsers.delete(userId);
					const userName = this.userNameCache.get(userId) || "退出したユーザー";

					console.log(
						`👤 ユーザー退出確定（定期チェック）: ${userName} (ID: ${userId})`,
					);
					console.log(`🔄 Slack退出通知を送信中: ${userName}`);

					await this.notifyUserLeft(userId, userName);
					console.log(`✅ 退出通知送信完了: ${userName}`);
				}
			}

			// 実際にいるが追跡していないユーザー（参加した可能性）
			for (const userId of currentPlayers) {
				if (!trackedUsers.has(userId) && this.initialUsersLoaded) {
					console.log(`🔍 新規参加を検出（定期チェック）: ${userId}`);

					// 参加処理（重複チェック付き）
					const recentEventKey = Array.from(this.processedJoinEvents).find(
						(key) =>
							key.startsWith(userId) &&
							Date.now() - parseInt(key.split("-")[1]) < 60000, // 1分以内
					);

					if (!recentEventKey) {
						const eventKey = `${userId}-${Date.now()}`;
						this.processedJoinEvents.add(eventKey);
						this.connectedUsers.add(userId);

						// プレイヤー情報から名前を取得
						const playerData = this.game.players[userId];
						let userName = "新しいユーザー";
						if (
							playerData &&
							playerData.name &&
							playerData.name.trim() !== ""
						) {
							userName = playerData.name.trim();
							this.userNameCache.set(userId, userName);
						}

						console.log(
							`👤 ユーザー参加確定（定期チェック）: ${userName} (ID: ${userId})`,
						);
						console.log(`🔄 Slack参加通知を送信中: ${userName}`);

						await this.notifyUserJoined(userId, userName);
						console.log(`✅ 参加通知送信完了: ${userName}`);
					} else {
						console.log(`! 最近処理済みのため参加通知スキップ: ${userId}`);
					}
				}
			}

			console.log(
				`✅ 定期チェック完了 - 現在の追跡ユーザー数: ${this.connectedUsers.size}`,
			);
		} catch (error) {
			console.error("❌ 接続状態チェックエラー:", error);
		}
	}
	async loadInitialUsers() {
		try {
			console.log("📋 初期メンバーリストを取得中...");

			// 少し待ってからプレイヤー情報を取得
			await new Promise((resolve) => setTimeout(resolve, 2000));

			const players = this.game.players || {};
			const currentMembers = [];

			for (const [playerId, playerData] of Object.entries(players)) {
				if (playerData && playerData.name) {
					this.connectedUsers.add(playerId);
					this.userNameCache.set(playerId, playerData.name);
					currentMembers.push(playerData.name);
					console.log(`📝 初期メンバー: ${playerData.name} (ID: ${playerId})`);
				}
			}

			// 現在のメンバーリストをSlackに通知
			if (currentMembers.length > 0) {
				const memberList = currentMembers.join(", ");
				const message = `📋 **現在のGatherメンバー** (${currentMembers.length}人)\n${memberList}`;
				await this.sendSlackNotification(message, "#36a64f");
				console.log(
					`✅ 初期メンバーリスト通知完了: ${currentMembers.length}人`,
				);
			} else {
				await this.sendSlackNotification(
					"📋 現在Gatherスペースには誰もいません",
					"#808080",
				);
				console.log("i 初期メンバーなし");
			}

			this.initialUsersLoaded = true;

			// 初期ロード中に蓄積されたイベントを処理
			await this.processPendingEvents();

			// 定期的な接続監視を開始
			this.startConnectionMonitoring();
		} catch (error) {
			console.error("❌ 初期メンバーリスト取得エラー:", error);
			this.initialUsersLoaded = true; // エラーでも通常の監視を開始
			await this.processPendingEvents();
			this.startConnectionMonitoring();
		}
	}

	// 初期ロード中に蓄積されたイベントを処理
	async processPendingEvents() {
		if (this.pendingEvents.length > 0) {
			console.log(
				`🔄 初期ロード完了後の保留イベント処理開始: ${this.pendingEvents.length}件`,
			);

			for (const event of this.pendingEvents) {
				console.log(
					`🔄 保留イベント処理: ${event.type} (ID: ${event.playerId})`,
				);

				if (event.type === "playerJoins") {
					// 初期メンバーに含まれていない新規参加のみ通知
					if (!this.connectedUsers.has(event.playerId)) {
						console.log(
							`✅ 保留イベントを新規参加として処理: ${event.playerId}`,
						);
						await this.handlePlayerJoins(event.data, event.context);
					} else {
						console.log(
							`! 保留イベントは初期メンバーのため無視: ${event.playerId}`,
						);
					}
				} else if (event.type === "playerLeaves") {
					await this.handlePlayerLeaves(event.data, event.context);
				}
			}

			this.pendingEvents = []; // 処理済みイベントをクリア
			console.log(`✅ 保留イベント処理完了`);
		}
	}

	// プレイヤー参加処理（実際の処理ロジック）
	async handlePlayerJoins(data, context) {
		const playerId = context.playerId;

		// 短時間での重複イベントをチェック（5秒以内）
		const eventKey = `${playerId}-${Date.now()}`;
		const recentEventKey = Array.from(this.processedJoinEvents).find(
			(key) =>
				key.startsWith(playerId) &&
				Date.now() - parseInt(key.split("-")[1]) < 5000,
		);

		if (recentEventKey) {
			console.log(`! 重複参加イベントを無視: ${playerId} (5秒以内に処理済み)`);
			return;
		}

		if (!this.connectedUsers.has(playerId)) {
			console.log(`✅ 新規参加として処理開始: ${playerId}`);
			this.connectedUsers.add(playerId);
			this.processedJoinEvents.add(eventKey);

			// 古い処理済みイベントをクリーンアップ（10分以上古いもの）
			for (const key of this.processedJoinEvents) {
				if (Date.now() - parseInt(key.split("-")[1]) > 600000) {
					this.processedJoinEvents.delete(key);
				}
			}

			console.log("📊 完全なイベントデータ:", JSON.stringify(data, null, 2));
			console.log("📊 完全なcontextデータ:", JSON.stringify(context, null, 2));

			// ユーザー名取得（遅延取得の情報も含む）
			const result = await this.getUserName(playerId, data, context);

			console.log(
				`👤 ユーザー参加確定: ${result.name} (遅延取得: ${result.isDelayed})`,
			);

			// Slack通知を1回だけ送信
			this.notifyUserJoined(playerId, result.name);
		} else {
			console.log(`! 既に接続済みのユーザーのため通知スキップ: ${playerId}`);
			console.log(
				`📊 キャッシュされた名前: ${this.userNameCache.get(playerId) || "なし"}`,
			);
		}
	}

	// プレイヤー退出処理（実際の処理ロジック）
	async handlePlayerLeaves(data, context) {
		const playerId = context.playerId;

		console.log(`📤 退出処理チェック: ${playerId}`);
		console.log(
			`📊 connectedUsersに含まれている？: ${this.connectedUsers.has(playerId)}`,
		);

		if (this.connectedUsers.has(playerId)) {
			console.log(`✅ 退出処理開始: ${playerId}`);
			this.connectedUsers.delete(playerId);

			console.log(
				"📊 完全な退出イベントデータ:",
				JSON.stringify(data, null, 2),
			);
			console.log(
				"📊 完全な退出contextデータ:",
				JSON.stringify(context, null, 2),
			);

			// 退出時は遅延取得なし（キャッシュまたは即座に取得可能な情報のみ）
			const result = await this.getUserName(playerId, data, context, true);

			console.log(`👤 ユーザー退出確定: ${result.name}`);
			console.log(
				`📊 退出後の接続ユーザー: [${Array.from(this.connectedUsers).join(", ")}]`,
			);

			console.log(`🔄 Slack退出通知を送信中: ${result.name}`);
			await this.notifyUserLeft(playerId, result.name);
			console.log(`✅ Slack退出通知送信完了: ${result.name}`);

			// キャッシュは残しておく（再参加時のため）
			console.log(
				`📊 キャッシュ保持: ${this.userNameCache.get(playerId) || "なし"}`,
			);
		} else {
			console.log(`! 未接続のユーザーの退出イベント: ${playerId}`);
			console.log(
				`📊 現在の接続ユーザー一覧: [${Array.from(this.connectedUsers).join(", ")}]`,
			);
		}
	}
	async notifyUserJoined(playerId, playerName) {
		const message = `🎉 *${playerName}* さんがGatherスペースに参加しました！`;
		await this.sendSlackNotification(message, "#36a64f");
	}

	// ユーザー退出通知
	async notifyUserLeft(playerId, playerName) {
		const message = `👋 *${playerName}* さんがGatherスペースから退出しました`;
		console.log(`🔄 退出通知準備: ${message}`);

		try {
			const success = await this.sendSlackNotification(message, "#ff9900");
			if (success) {
				console.log(`✅ 退出通知送信成功: ${playerName}`);
			} else {
				console.log(`❌ 退出通知送信失敗: ${playerName}`);
			}
		} catch (error) {
			console.error(`❌ 退出通知エラー: ${error.message}`);
		}
	}

	// Gatherに接続
	async connect() {
		try {
			console.log("🔄 Gatherに接続中...");

			this.game = new Game(this.gatherSpaceId, () =>
				Promise.resolve({ apiKey: this.gatherApiKey }),
			);

			// 接続成功時のイベント
			this.game.subscribeToConnection((connected) => {
				if (connected) {
					console.log("✅ Gatherに接続しました");
					this.sendSlackNotification(
						"🤖 Gather Bot が起動しました！監視を開始します",
						"#0099ff",
					);

					// 初期メンバーリストを取得・通知
					this.loadInitialUsers();
				} else {
					console.log("❌ Gatherから切断されました");
					this.initialUsersLoaded = false; // 再接続時に初期化をやり直し
					// 再接続を試行
					setTimeout(() => {
						console.log("🔄 再接続を試行します...");
						this.connect();
					}, 5000);
				}
			});

			// プレイヤー参加イベント
			this.game.subscribeToEvent("playerJoins", async (data, context) => {
				try {
					const playerId = context.playerId;

					console.log(`📥 プレイヤー参加イベント受信 (ID: ${playerId})`);
					console.log(`📊 初期ロード完了: ${this.initialUsersLoaded}`);
					console.log(
						`📊 現在の接続ユーザー: [${Array.from(this.connectedUsers).join(", ")}]`,
					);
					console.log(
						`📊 このユーザーは既に接続済み？: ${this.connectedUsers.has(playerId)}`,
					);

					// 初期ロード完了前は保留
					if (!this.initialUsersLoaded) {
						console.log(`⏳ 初期ロード中のためイベントを保留: ${playerId}`);
						this.pendingEvents.push({
							type: "playerJoins",
							playerId: playerId,
							data: data,
							context: context,
						});
						return;
					}

					// 初期ロード完了後は通常処理
					await this.handlePlayerJoins(data, context);
				} catch (error) {
					console.error("❌ プレイヤー参加処理エラー:", error);
				}
			});

			// プレイヤー退出イベント
			this.game.subscribeToEvent("playerLeaves", async (data, context) => {
				try {
					const playerId = context.playerId;

					console.log(`📤 プレイヤー退出イベント受信 (ID: ${playerId})`);
					console.log(
						`📊 現在の接続ユーザー: [${Array.from(this.connectedUsers).join(", ")}]`,
					);
					console.log(
						`📊 このユーザーは接続済み？: ${this.connectedUsers.has(playerId)}`,
					);

					// 初期ロード完了前は保留
					if (!this.initialUsersLoaded) {
						console.log(`⏳ 初期ロード中のためイベントを保留: ${playerId}`);
						this.pendingEvents.push({
							type: "playerLeaves",
							playerId: playerId,
							data: data,
							context: context,
						});
						return;
					}

					// 初期ロード完了後は通常処理
					await this.handlePlayerLeaves(data, context);
				} catch (error) {
					console.error("❌ プレイヤー退出処理エラー:", error);
				}
			});

			// プレイヤー移動イベント（オプション - デバッグ用）
			this.game.subscribeToEvent("playerMoves", (data, context) => {
				// 必要に応じて位置情報の変更も通知可能
				// console.log(`🚶 ${context.playerId} が移動しました`);
			});

			// チャットメッセージイベント（オプション）
			this.game.subscribeToEvent("playerChats", (data, context) => {
				try {
					const playerId = context.playerId;
					const playerName = this.getUserName(playerId, null, context);
					const message = data.contents;

					console.log(`💬 ${playerName}: ${message}`);
					// 必要に応じてチャットもSlackに転送可能
					// this.sendSlackNotification(`💬 **${playerName}**: ${message}`, '#cccccc');
				} catch (error) {
					console.error("❌ チャット処理エラー:", error);
				}
			});

			// エラーハンドリング
			this.game.subscribeToEvent("error", (error) => {
				console.error("❌ Gatherエラー:", error);
				this.sendSlackNotification(
					`! Gather Bot でエラーが発生: ${error.message}`,
					"#ff0000",
				);
			});

			// 接続開始
			await this.game.connect();
			console.log("🚀 Gather接続プロセス開始");
		} catch (error) {
			console.error("❌ 接続エラー:", error);
			// 5秒後に再試行
			setTimeout(() => {
				console.log("🔄 5秒後に再接続を試行します...");
				this.connect();
			}, 5000);
		}
	}

	// 現在の接続ユーザー数を取得
	getCurrentUserCount() {
		return this.connectedUsers.size;
	}

	// 定期的なステータス報告（オプション）
	startStatusReporting(intervalMinutes = 60) {
		setInterval(
			async () => {
				const userCount = this.getCurrentUserCount();
				const message = `📊 現在のGatherスペース参加者数: ${userCount}人`;
				await this.sendSlackNotification(message, "#808080");
				console.log(`📊 定期報告: 参加者数 ${userCount}人`);
			},
			intervalMinutes * 60 * 1000,
		);
	}

	// 正常性チェック
	healthCheck() {
		const status = {
			isConnected: this.game ? this.game.isConnected : false,
			userCount: this.getCurrentUserCount(),
			timestamp: new Date().toISOString(),
		};
		console.log("💊 ヘルスチェック:", status);
		return status;
	}

	// Bot停止時のクリーンアップ
	async disconnect() {
		try {
			// 定期チェックを停止
			if (this.connectionCheckInterval) {
				clearInterval(this.connectionCheckInterval);
				console.log("🛑 定期接続チェックを停止しました");
			}

			if (this.game) {
				await this.sendSlackNotification(
					"🤖 Gather Bot を停止します",
					"#ff0000",
				);
				this.game.disconnect();
				console.log("✅ Gatherから切断しました");
			}
		} catch (error) {
			console.error("❌ 切断エラー:", error);
		}
	}
}

// HTTPサーバー作成（App Runner要件）
function createHealthServer(bot) {
	const server = http.createServer((req, res) => {
		// CORS設定
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (req.method === "OPTIONS") {
			res.writeHead(200);
			res.end();
			return;
		}

		if (req.url === "/health" || req.url === "/") {
			const status = {
				status: "healthy",
				timestamp: new Date().toISOString(),
				uptime: Math.floor(process.uptime()),
				memory: {
					used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
					total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
				},
				bot: {
					connectedUsers: bot ? bot.getCurrentUserCount() : 0,
					initialLoaded: bot ? bot.initialUsersLoaded : false,
					gatherConnected: bot && bot.game ? !!bot.game.isConnected : false,
				},
				version: process.env.npm_package_version || "1.0.0",
				environment: process.env.NODE_ENV || "development",
			};

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(status, null, 2));
		} else if (req.url === "/status") {
			const detailedStatus = {
				service: {
					name: "Gather Slack Bot",
					version: "1.0.0",
					environment: process.env.NODE_ENV,
					region: process.env.AWS_REGION,
				},
				bot: {
					connected: bot && bot.game ? !!bot.game.isConnected : false,
					userCount: bot ? bot.getCurrentUserCount() : 0,
					cacheSize: bot ? bot.userNameCache.size : 0,
					initialLoaded: bot ? bot.initialUsersLoaded : false,
					pendingEvents: bot ? bot.pendingEvents.length : 0,
				},
				system: {
					nodeVersion: process.version,
					platform: process.platform,
					arch: process.arch,
					uptime: Math.floor(process.uptime()),
					pid: process.pid,
				},
				memory: process.memoryUsage(),
				lastHealthCheck: new Date().toISOString(),
			};

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(detailedStatus, null, 2));
		} else if (req.url === "/metrics") {
			const metrics = {
				uptime_seconds: process.uptime(),
				memory_usage_mb: Math.round(
					process.memoryUsage().heapUsed / 1024 / 1024,
				),
				connected_users_count: bot ? bot.getCurrentUserCount() : 0,
				cache_size: bot ? bot.userNameCache.size : 0,
				bot_connected: bot && bot.game ? (bot.game.isConnected ? 1 : 0) : 0,
				timestamp: Date.now(),
			};

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(metrics));
		} else {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: "Not Found",
					availableEndpoints: ["/health", "/status", "/metrics"],
				}),
			);
		}
	});

	return server;
}

// メイン実行関数
async function main() {
	console.log("🚀 Gather Slack Bot 起動中...");
	console.log(`📅 起動時刻: ${new Date().toLocaleString("ja-JP")}`);
	console.log(`🌐 環境: ${process.env.NODE_ENV || "development"}`);
	console.log(`📍 ポート: ${process.env.PORT || 3000}`);
	console.log(`🏗 Platform: ${process.platform} ${process.arch}`);
	console.log(`📦 Node.js: ${process.version}`);

	const bot = new GatherSlackBot();

	try {
		// AWS Secrets Managerから設定を取得
		await bot.loadSecretsFromAWS();

		// 設定の最終確認
		bot.validateConfiguration();
	} catch (error) {
		console.error("❌ 初期化エラー:", error.message);
		process.exit(1);
	}

	// HTTPサーバー起動
	const server = createHealthServer(bot);
	const PORT = process.env.PORT || 3000;

	server.listen(PORT, "0.0.0.0", () => {
		console.log(`🌐 HTTPサーバーがポート${PORT}で起動しました`);
		console.log(`🔗 ヘルスチェック: http://localhost:${PORT}/health`);
		console.log(`📊 ステータス: http://localhost:${PORT}/status`);
		console.log(`📈 メトリクス: http://localhost:${PORT}/metrics`);
	});

	// 正常終了時の処理
	const gracefulShutdown = async (signal) => {
		console.log(`\n🛑 ${signal} 受信: Bot停止中...`);

		// HTTPサーバーを停止
		server.close(() => {
			console.log("🌐 HTTPサーバーを停止しました");
		});

		// Botを停止
		await bot.disconnect();

		console.log("✅ 正常終了しました");
		process.exit(0);
	};

	process.on("SIGINT", () => gracefulShutdown("SIGINT"));
	process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

	// 未処理エラーのハンドリング
	process.on("unhandledRejection", (reason, promise) => {
		console.error("未処理のPromise拒否:", reason);
		if (bot.slackWebhookUrl) {
			bot
				.sendSlackNotification(`! 未処理エラー: ${reason}`, "#ff0000")
				.catch(console.error);
		}
	});

	process.on("uncaughtException", (error) => {
		console.error("未処理の例外:", error);
		if (bot.slackWebhookUrl) {
			bot
				.sendSlackNotification(`! 重大エラー: ${error.message}`, "#ff0000")
				.catch(console.error);
		}
		setTimeout(() => process.exit(1), 1000);
	});

	try {
		// Bot接続開始
		await bot.connect();

		// 1時間ごとにステータス報告
		bot.startStatusReporting(60);

		// 30分ごとにヘルスチェック
		setInterval(
			() => {
				bot.healthCheck();
			},
			30 * 60 * 1000,
		);

		console.log("🚀 Gather Slack Bot が正常に起動しました！");
		console.log("💡 App Runnerで実行中...");

		// App Runner用の起動確認通知
		await bot.sendSlackNotification(
			"🚀 Gather Bot (App Runner) が起動しました！",
			"#00ff00",
		);
	} catch (error) {
		console.error("❌ Bot起動エラー:", error);
		await bot.sendSlackNotification(
			`! Bot起動失敗: ${error.message}`,
			"#ff0000",
		);
		process.exit(1);
	}
}

// Bot起動
if (require.main === module) {
	main().catch((error) => {
		console.error("❌ メイン関数エラー:", error);
		process.exit(1);
	});
}

module.exports = GatherSlackBot;
