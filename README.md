# gather-slack-bot

## Env
```bash
cp .env.example .env
```

## Local

### Quick Start
```bash
npm install
npm run start
```

## Docker

### Build
```bash
# イメージビルド
docker build -t gather-slack-bot .

# タグ付きビルド
docker build -t gather-slack-bot:v1.0.0 .
```

### Run
```bash
# コンテナ起動
docker run -d \
  --name gather-bot \
  --env-file .env \
  --restart unless-stopped \
  gather-slack-bot

# ログ確認
docker logs gather-bot -f

# コンテナ内に入る
docker exec -it gather-bot sh

# 停止・削除
docker stop gather-bot
docker rm gather-bot
```

### Compose
```bash
# バックグラウンド起動
docker-compose up -d

# ログ監視
docker-compose logs -f

# 再起動
docker-compose restart

# 停止・削除
docker-compose down

# イメージ再ビルド
docker-compose up -d --build
```

### Others
```bash
# コンテナ状況
docker stats gather-bot
git pull origin main

# 2. イメージ再ビルド・再起動
docker-compose up -d --build

# または手動
docker stop gather-bot
docker rm gather-bot
docker build -t gather-slack-bot .
docker run -d --name gather-bot --env-file .env gather-slack-bot

# Docker完全リセット
docker-compose down
docker system prune -f
docker-compose up -d --build
```


## License
[MIT](LICENSE)
