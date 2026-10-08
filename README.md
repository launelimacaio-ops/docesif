# GustaDoces

Requisitos: Node 22.13+ (sem `npm install`, sem dependências).

## Rodar
    AUTH_SECRET="uma-chave-longa-e-secreta" ADMIN_PASSWORD="caio123" node server.js
Abra http://localhost:3000. Admin: admin@gustadoces.com (senha = ADMIN_PASSWORD; padrão de teste: admin123, troque!).

## Onde configurar
- `AUTH_SECRET`: chave de assinatura do login (obrigatório em produção).
- `ADMIN_PASSWORD`: senha do admin criado na primeira execução.
- `DB_FILE` / `PORT`: arquivo do banco SQLite e porta.
- PIX/cartão: em `server.js`, rota `POST /api/orders`, no bloco `if (b.payment !== 'carteira')`.
  Ali crie a cobrança no gateway (Mercado Pago, Stripe, Asaas...) com a chave em variável de ambiente
  (ex.: `GATEWAY_KEY`), grave o pedido como pendente e só marque como "Pago" no webhook do gateway.
  Dados de cartão nunca passam pelo seu servidor: use o checkout/tokenização do gateway.

## Segurança
Senhas com scrypt, token assinado (HMAC), rotas `/api/admin/*` só para admin, cliente só vê os próprios pedidos/carteira,
preços/frete/total sempre recalculados no backend, compra na carteira em transação atômica, estorno automático ao cancelar.
