const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware Frontend
app.use(cors({
  origin: ['http://localhost:5173', 'https://painelpb.onrender.com'],
  credentials: true
}));
app.use(express.json());

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/clients', require('./routes/clientes')); // Esta rota já existe
app.use('/faturamentos', require('./routes/faturamentos')); // NOVA ROTA ADICIONADA AQUI
app.use('/crm-occurrences', require('./routes/crm-ocorrencias'));
app.use('/gestor-occurrences', require('./routes/gestorOccurrences'));
app.use('/users', require('./routes/users'));
app.use('/audit-logs', require('./routes/auditLogs')); 

// NOVAS ROTAS PARA O DASHBOARD
app.use('/mensagens-motivacionais', require('./routes/mensagensMotivacionais'));
app.use('/ranking-mapia', require('./routes/rankingMapia'));
app.use('/perguntas-semana', require('./routes/perguntasSemana'));

// NOVAS ROTAS PARA ANALISE CONTRATUAL
app.use('/cargos', require('./routes/cargosRoutes')); 
app.use('/faturamentos', require('./routes/faturamentos'));
app.use('/setores', require('./routes/setoresRoutes'));
app.use('/configuracao-analise', require('./routes/configuracaoAnaliseRoutes'));
app.use('/alocacao-esforco', require('./routes/alocacaoEsforcoRoutes'));
app.use('/analise-contratual', require('./routes/analiseContratualRoutes'));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'CRM Backend is running',
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'CRM Backend API',
    version: '1.0.0',
    // Você pode adicionar '/faturamentos' aqui se quiser listá-lo
    endpoints: ['/auth/login', '/auth/verify', '/clients', '/faturamentos', '/crm-occurrences', '/gestor-occurrences', '/users', '/audit-logs', '/health'] 
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});
