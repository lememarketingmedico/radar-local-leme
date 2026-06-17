# Radar Local LEME V3.3

Versão V3.3 do Radar Local LEME com melhorias de usabilidade e um relatório redesenhado.

## O que mudou nesta versão

- ícone lateral mais clean para mover o grid;
- movimento fluido do grid durante o arraste;
- opção de editar cliente;
- mapa mais clean no app e no relatório, ocultando estabelecimentos e POIs;
- relatório 1920 x 1080 totalmente redesenhado, com foco maior no mapa;
- grid e mapa mantidos sem distorção.

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

Volume persistente:

```txt
/app/data
```
