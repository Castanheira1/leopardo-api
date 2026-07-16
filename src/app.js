// Instância única do Express, compartilhada pelos módulos de rota.
// A ordem de require em server.js define a ordem de registro das rotas.
const express = require("express");

module.exports = express();
