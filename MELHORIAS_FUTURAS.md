# Melhorias Futuras — VAP

## Validação de Admin por Chamado

### Contexto
O acesso admin concede visibilidade sobre relatórios de uso, custos por projeto e rateio por empresa. Para evitar admins falsos — que têm poder de autorizar medições e pagamentos no sistema da Vale — o processo de criação de admin deve ser validado pela plataforma antes de ser ativado no banco de dados.

### Fluxo planejado
1. Usuário clica em "Solicitar acesso admin" no cadastro
2. Preenche o formulário (nome, matrícula, empresa, projeto, telefone, email, justificativa)
3. A plataforma (operador interno) recebe o chamado em uma fila
4. O operador inicia uma conversa por chat/WhatsApp com o solicitante para validar identidade e função
5. Após validação, o operador clica em "Aprovar" na plataforma
6. O sistema cria automaticamente o usuário admin no banco com `is_admin = TRUE` e `admin_projeto_id` definido
7. O novo admin recebe notificação e pode acessar o painel do projeto

### Já implementado (2026-07)
- Tabela `admin_chamados` (status: pendente / aprovado / recusado)
- Formulário público no cadastro (`registro.html` → "Solicitar acesso admin")
- `GET /api/admin/chamados?status=...` — fila por projeto do admin
- `POST /api/admin/chamados/:id/aprovar` — cria/promove o usuário a admin do
  projeto (senha inicial 123456) — e `POST .../recusar`
- Interface da fila no painel (`admin.html` → seção "Acesso admin", com badge
  de pendências e link de WhatsApp para validar identidade antes de aprovar)

### O que ainda falta
- Chat integrado (WhatsApp Business API ou similar) para validação — hoje a
  validação é manual pelo link de WhatsApp da fila
- Notificação automática ao aprovado (e-mail ou WhatsApp)

---

## Rateio Automático por Empresa

### Contexto
Hoje a Vale paga R$5,00/usuário ativo/mês por todos os colaboradores no S11D, independente da empresa contratada. No futuro, cada empresa (MCA, Serveng, etc.) pagará pelos seus próprios usuários ativos.

### Fluxo planejado
1. Definir contratos por empresa × projeto (`contratos` table já criada)
2. No fechamento mensal (dia 1 ou sob demanda), gerar relatório via `GET /api/rateio`
3. Relatório lista: nome, matrícula, empresa, CC, viagens no período, custo
4. Exportar para Excel/PDF e encaminhar ao RH/financeiro da empresa
5. Cobrar via boleto/PIX (integração Pagar.me ou faturamento direto)

### Endpoint já implementado
`GET /api/rateio?projeto_id=X` — retorna usuários ativos (40 dias), agrupados por projeto/empresa/CC

---

## IA de Gestão por Projeto

### Contexto
Cada projeto (S11D, Salobo, etc.) terá um admin que pode conversar com uma IA para obter relatórios e insights sem precisar navegar em painéis complexos.

### Exemplos de perguntas
- "Quantos usuários ativos no S11D esse mês?"
- "Qual empresa tem mais usuários sem carona nos últimos 7 dias?"
- "Gere o relatório de rateio de junho para a MCA"
- "Qual o horário de pico de solicitações de carona?"

### O que falta implementar
- Assistente de IA conectado ao endpoint `/api/rateio` e outros endpoints de stats
- Interface de chat para o admin (web ou WhatsApp)
- Memória de contexto por projeto (o admin do S11D só vê dados do S11D)

---

## Multi-empresa com Isolamento Total

### O que falta
- Aplicar `projeto_id` como filtro em todas as queries de caronas/pedidos (hoje usuários de projetos diferentes podem se ver)
- Criar contratos e faturamento automático por empresa
- Painel financeiro para a equipe interna da plataforma
