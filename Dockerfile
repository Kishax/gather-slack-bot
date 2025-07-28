# App Runner用最適化Dockerfile
FROM node:18-alpine

# メンテナ情報
LABEL maintainer="your-email@example.com"
LABEL description="Gather to Slack notification bot for App Runner"

# 作業ディレクトリを設定
WORKDIR /app

# 必要なパッケージをインストール
RUN apk update && apk add --no-cache \
    tzdata \
    && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && echo "Asia/Tokyo" > /etc/timezone \
    && apk del tzdata

# package.jsonとpackage-lock.json（存在する場合）をコピー
COPY package*.json ./

# 依存関係をインストール（本番環境用）
RUN npm ci --only=production && \
    npm cache clean --force

# アプリケーションファイルをコピー
COPY index.js ./

# 環境変数設定
ENV NODE_ENV=production
ENV PORT=3000

# 非rootユーザーを作成（権限問題回避）
RUN addgroup -g 1001 -S nodejs && \
    adduser -S gather-bot -u 1001 -G nodejs

# アプリケーションディレクトリの所有者を変更
RUN chown -R gather-bot:nodejs /app

# 非rootユーザーに切り替え
USER gather-bot

# ポート公開
EXPOSE 3000

# ヘルスチェック設定（App Runner用）
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# アプリケーション起動（PM2なし、直接Node.js実行）
CMD ["node", "index.js"]
