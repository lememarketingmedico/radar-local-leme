# Radar Local LEME

App interno para analisar posicionamento local no Google Maps/Google Business Profile usando grid de busca.

## O que esta V1 faz

- Login interno simples
- Cadastro de clientes
- Cadastro de palavras-chave
- Grid 3x3 ou 5x5
- Scan manual usando Google Places API
- Mapa visual com cores
- Histórico de análises
- Dados salvos em `data/db.json`

## Variáveis de ambiente

Copie `.env.example` para `.env` e preencha:

```env
APP_USER=leme
APP_PASSWORD=sua-senha
SESSION_SECRET=um-texto-grande-aleatorio
GOOGLE_MAPS_FRONTEND_KEY=sua-chave-frontend
GOOGLE_MAPS_BACKEND_KEY=sua-chave-backend
PORT=3000
```

## Rodar localmente

```bash
npm install
npm start
```

Abra:

```text
http://localhost:3000
```

## Rodar no EasyPanel

1. Suba este projeto para o GitHub.
2. No EasyPanel, crie um app a partir do repositório.
3. Configure as variáveis de ambiente.
4. Crie um volume persistente em `/app/data` para não perder os dados.
5. Publique na porta `3000`.

## Observação importante

Este app usa a Places API com FieldMask reduzido para buscar principalmente o ID dos locais. Isso reduz custo, mas o resultado deve ser tratado como uma fotografia do momento, não como uma garantia absoluta de ranking para todos os usuários.
