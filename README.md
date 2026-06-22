# Radar Local LEME V4.4 - Ranking com Cliente

Esta versão corrige o ranking de perfis encontrados para incluir também o cliente analisado na posição correta, além de manter o módulo **Insights Clientes**.

## Novidades

- ranking agora mostra o **cliente analisado** junto dos concorrentes;
- cliente analisado aparece com selo visual e sem botão de gerar grid;
- correção para o cliente aparecer na ordem real da média;
- botão **Insights Clientes** no menu;
- conexão com conta Google via OAuth;
- sincronização dos perfis administrados pela conta Google da LEME;
- geração de relatório de insights por perfil e período;
- relatório PNG com impressões, interações, chamadas, rotas e visitas ao site.

## Variáveis novas no EasyPanel

```env
GOOGLE_OAUTH_CLIENT_ID=cole_o_client_id_aqui
GOOGLE_OAUTH_CLIENT_SECRET=cole_o_client_secret_aqui
GOOGLE_OAUTH_REDIRECT_URI=https://maps.sistemaleme.com.br/api/google/callback
GOOGLE_INSIGHTS_SCOPES=https://www.googleapis.com/auth/business.manage
TOKEN_ENCRYPTION_SECRET=texto-grande-com-32-ou-mais-caracteres
```

Mantenha também as variáveis antigas do Radar Local.

## APIs necessárias no Google Cloud

- Business Profile Performance API
- Business Information API
- Account Management API

## Importante

Não suba a pasta `data` para o GitHub. O volume persistente no EasyPanel deve continuar como `/app/data`.
