const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());

// Routes
app.use('/auth', authRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'CRM API funcionando!' });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
