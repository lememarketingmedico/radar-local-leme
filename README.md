# Radar Local LEME V4.2

Versão com as funções pedidas até a V4.2:

- V4.0: ajuste do relatório para o mapa focar no grid completo, com margem visual melhor.
- V4.1: tela **Análise rápida** para prospectar sem cadastrar cliente.
- V4.2: ranking de concorrentes com botão **Gerar grid** para analisar o concorrente com a mesma palavra-chave, grid, raio e centro.

## Importante

Não suba a pasta `data` para o GitHub.
Mantenha o volume persistente no EasyPanel em:

```txt
/app/data
```

## Variáveis de ambiente

```env
APP_USER=leme
APP_PASSWORD=sua-senha
SESSION_SECRET=um-texto-grande-fixo
GOOGLE_MAPS_FRONTEND_KEY=sua-chave-frontend
GOOGLE_MAPS_BACKEND_KEY=sua-chave-backend
N8N_WEBHOOK_URL=https://n8n.adati.app.br/webhook/radar-local-leme
AUTOMATION_TOKEN=crie-um-token-seguro
PORT=3000
```

## APIs necessárias

- Maps JavaScript API
- Maps Static API
- Places API (New)
- Geocoding API

## Observação de custo

A análise normal usa IDs Only. O ranking de concorrentes e a análise rápida usam nomes/localização de perfis e podem acionar SKUs pagos, então use essas funções de forma estratégica.
