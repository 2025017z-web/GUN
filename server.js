const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ミドルウェア設定
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ルートエンドポイント
app.get('/', (req, res) => {
  res.json({ message: 'Server is running successfully!' });
});

// ヘルスチェック用API
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// POSTリクエストの受信例
app.post('/api/data', (req, res) => {
  const body = req.body;
  res.status(201).json({
    message: 'Data received',
    receivedData: body
  });
});

// 404 エラーハンドリング
app.use((req, res) => {
  res.status(404).json({ error: 'Route Not Found' });
});

// グローバルエラーハンドリング
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
