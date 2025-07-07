const bcrypt = require('bcryptjs');
bcrypt.hash('senha123', 10).then(console.log);