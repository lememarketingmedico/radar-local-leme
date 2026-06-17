# Radar Local LEME V3.2

Versão V3.2 do Radar Local LEME com:

- cadastro resumido de clientes;
- edição de clientes já cadastrados;
- status ativo/inativo para clientes e palavras-chave;
- localização automática por Place ID ou endereço;
- centro do grid ajustável no mapa;
- ícone lateral para mover o grid inteiro de forma mais intuitiva;
- grid 3x3, 5x5 e 7x7;
- raio livre de 0,2 km a 50 km;
- relatório horizontal 1920 x 1080 com foco maior no mapa;
- mapa real no relatório usando Google Static Maps API;
- envio manual para n8n;
- automação em massa via endpoint para n8n.

## Variáveis de ambiente

Configure no EasyPanel:

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

Importante: para o relatório baixar com mapa real, ative a **Maps Static API** no Google Cloud e adicione essa API nas permissões da chave Backend.

## EasyPanel

Use o `Dockerfile` do projeto.

Porta: `3000`

Volume persistente:

```txt
/app/data
```

Não monte volume em `/app`, apenas em `/app/data`.

## Endpoint para n8n disparar tudo

O n8n deve fazer um HTTP Request para:

```txt
POST https://maps.sistemaleme.com.br/api/automation/run-all
```

Header:

```json
{
  "x-automation-token": "SEU_AUTOMATION_TOKEN"
}
```

Body:

```json
{
  "sendToN8n": true,
  "gridSize": 5,
  "radiusKm": 3,
  "useSavedGridCenter": true,
  "keywords": "active_only"
}
```

O app gera as análises e envia cada relatório para:

```txt
https://n8n.adati.app.br/webhook/radar-local-leme
```
