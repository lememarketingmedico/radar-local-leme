# Radar Local LEME V3.4

Versão de correção de segurança dos dados e cadastro de clientes.

## Correções desta versão

- Corrige criação e edição de clientes.
- Remove `data/db.json` do pacote para não sobrescrever dados existentes.
- Adiciona backup automático do banco em `/app/data/backups` antes de alterações.
- Mantém relatório, mapa clean, grid arrastável e automações da V3.3.

## Muito importante

Não suba a pasta `data` para o GitHub.

O banco real deve ficar apenas no volume persistente do EasyPanel:

```txt
/app/data
```

Se você subir `data/db.json` no GitHub, pode sobrescrever dados em deploys futuros caso o volume não esteja configurado corretamente.

## Variáveis de ambiente

```env
APP_USER=leme
APP_PASSWORD=sua-senha
SESSION_SECRET=um-texto-grande-aleatorio
GOOGLE_MAPS_FRONTEND_KEY=sua-chave-frontend
GOOGLE_MAPS_BACKEND_KEY=sua-chave-backend
N8N_WEBHOOK_URL=https://n8n.adati.app.br/webhook/radar-local-leme
AUTOMATION_TOKEN=crie-um-token-seguro
PORT=3000
```

## APIs do Google necessárias

Frontend:
- Maps JavaScript API

Backend:
- Places API (New)
- Geocoding API
- Maps Static API

## EasyPanel

Use o Dockerfile do projeto.

Porta: `3000`

Volume persistente obrigatório:

```txt
/app/data
```
