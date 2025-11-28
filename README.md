
# 🚗 LEOPARDO - Sistema de Agendamento de Veículos

Sistema completo de agendamento de veículos corporativos com autenticação, painel administrativo e dashboard de estatísticas.

## 📋 Funcionalidades

### Usuários
- ✅ Cadastro e login com autenticação JWT
- ✅ Recuperação de senha via email
- ✅ Visualizar veículos disponíveis por período
- ✅ Criar agendamentos com justificativa
- ✅ Cancelar agendamentos
- ✅ Visualizar histórico de agendamentos

### Administradores
- ✅ Dashboard com estatísticas completas
- ✅ Cadastrar e gerenciar veículos
- ✅ Ativar/desativar veículos
- ✅ Visualizar todos os agendamentos
- ✅ Relatórios de uso e usuários mais ativos

## 🛠️ Tecnologias

**Backend:**
- Node.js + Express
- PostgreSQL
- JWT + bcrypt
- Helmet + Rate Limiting
- Winston (logs)
- Nodemailer (emails)

**Frontend:**
- HTML5 + CSS3 + JavaScript Vanilla
- Design responsivo
- Interface moderna e intuitiva

## 📦 Instalação

### Método 1: Docker (Recomendado)

```bash
# Clone o repositório
git clone <url-do-repositorio>
cd leopardo

# Configure as variáveis de ambiente
cp .env.example .env
# Edite o .env com suas configurações

# Inicie os containers
docker-compose up -d

# Acesse: http://localhost:3000
```

### Método 2: Manual

```bash
# Clone o repositório
git clone <url-do-repositorio>
cd leopardo

# Instale as dependências
npm install

# Configure o banco de dados PostgreSQL
createdb leopardo
psql -U postgres -d leopardo -f schema.sql

# Configure as variáveis de ambiente
cp .env.example .env
# Edite o .env com suas configurações

# Inicie o servidor
npm start

# Para desenvolvimento (com hot reload)
npm run dev
```

## ⚙️ Configuração

### Variáveis de Ambiente (.env)

```env
# Banco de Dados
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/leopardo

# Segurança
JWT_SECRET=seu-segredo-super-secreto-aqui-minimo-32-caracteres

# Servidor
PORT=3000
NODE_ENV=development

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=seu-email@gmail.com
SMTP_PASS=sua-senha-de-app
EMAIL_FROM=noreply@leopardo.com

# Frontend
FRONTEND_URL=http://localhost:3000
```

### Configuração de Email (Gmail)

1. Acesse sua conta Google
2. Ative a verificação em duas etapas
3. Gere uma senha de app em: https://myaccount.google.com/apppasswords
4. Use a senha gerada no `.env` em `SMTP_PASS`

## 👤 Usuários Padrão

Após executar o `schema.sql`, os seguintes usuários estarão disponíveis:

**Administrador:**
- Matrícula: `000000`
- Senha: `admin123`

**Usuário Teste:**
- Matrícula: `123456`
- Senha: `senha123`

⚠️ **IMPORTANTE:** Altere essas senhas em produção!

## 📁 Estrutura de Arquivos

```
leopardo/
├── server.js              # Backend principal
├── package.json           # Dependências
├── schema.sql             # Esquema do banco de dados
├── .env.example           # Exemplo de variáveis de ambiente
├── Dockerfile             # Container Docker
├── docker-compose.yml     # Orquestração Docker
├── README.md              # Este arquivo
└── public/                # Frontend
    ├── index.html         # Login
    ├── registro.html      # Cadastro
    ├── dashboard.html     # Dashboard do usuário
    ├── admin.html         # Painel administrativo
    ├── recuperar-senha.html
    ├── redefinir-senha.html
    ├── app.js             # Funções JavaScript globais
    └── style.css          # Estilos
```

## 🔒 Segurança

O sistema implementa várias camadas de segurança:

- ✅ Senhas hasheadas com bcrypt
- ✅ Autenticação JWT com expiração
- ✅ Rate limiting para prevenir ataques
- ✅ Helmet.js para headers de segurança
- ✅ CORS configurado
- ✅ Validação de dados com express-validator
- ✅ Prepared statements (proteção contra SQL injection)
- ✅ Logs estruturados com Winston

## 📊 API Endpoints

### Autenticação
- `POST /api/register` - Cadastrar usuário
- `POST /api/login` - Login
- `POST /api/recuperar-senha` - Recuperar senha
- `POST /api/redefinir-senha` - Redefinir senha

### Agendamentos (requer autenticação)
- `GET /api/agendamentos/disponiveis` - Listar veículos disponíveis
- `POST /api/agendamentos` - Criar agendamento
- `GET /api/meus-agendamentos` - Meus agendamentos
- `DELETE /api/agendamentos/:id` - Cancelar agendamento

### Admin (requer autenticação + permissão admin)
- `POST /api/veiculos` - Cadastrar veículo
- `GET /api/veiculos` - Listar veículos
- `PATCH /api/veiculos/:id/toggle` - Ativar/desativar veículo
- `GET /api/admin/agendamentos` - Listar todos agendamentos
- `GET /api/admin/stats` - Dashboard de estatísticas

## 🧪 Testes

```bash
# Executar testes
npm test

# Executar com cobertura
npm test -- --coverage
```

## 🚀 Deploy em Produção

### Heroku

```bash
heroku create leopardo-app
heroku addons:create heroku-postgresql:hobby-dev
heroku config:set JWT_SECRET=seu-segredo-aqui
heroku config:set NODE_ENV=production
# Configure outras variáveis...
git push heroku main
```

### VPS (Ubuntu)

```bash
# Instale Docker e Docker Compose
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Clone e configure
git clone <url-do-repositorio>
cd leopardo
cp .env.example .env
nano .env  # Configure as variáveis

# Inicie
docker-compose up -d

# Configure nginx como proxy reverso
# Configure SSL com Let's Encrypt
```

## 📝 Licença

MIT

## 👨‍💻 Autor

Sistema Leopardo - Desenvolvido para gestão de veículos corporativos

## 🆘 Suporte

Para problemas ou dúvidas, abra uma issue no repositório.

---

**Desenvolvido com ❤️ para facilitar a gestão de veículos corporativos**


