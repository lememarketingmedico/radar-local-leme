# Radar Local LEME V4.5 - Busca de Leads

Esta versão adiciona uma nova aba **Busca de leads** para encontrar possíveis prospects somente por palavra-chave e gerar grid completo para qualquer perfil encontrado.

## Novidades

- nova aba **Busca de leads** no menu;
- busca por palavra-chave, sem precisar cadastrar cliente;
- ranking de perfis encontrados no grid, com média, melhor posição, presença e Top 10;
- botão **Gerar grid** em cada possível lead;
- ao gerar grid, o perfil vira uma análise rápida com ranking de concorrentes;
- mantém a correção anterior em que o cliente analisado aparece no ranking;
- mantém o módulo **Insights Clientes**.

## Como usar a Busca de leads

1. Entre em **Busca de leads**.
2. Digite uma palavra-chave com cidade, por exemplo: `psiquiatra infantil Uberlândia`.
3. Escolha grid e raio.
4. Clique em **Buscar leads**.
5. Na tabela, clique em **Gerar grid** no perfil que quiser analisar.

## Observação de custo

A Busca de leads usa nomes dos perfis encontrados, então pode cair em Places Text Search Pro. Use como ferramenta estratégica de prospecção.

## Variáveis do Insights Clientes

```env
GOOGLE_OAUTH_CLIENT_ID=cole_o_client_id_aqui
GOOGLE_OAUTH_CLIENT_SECRET=cole_o_client_secret_aqui
GOOGLE_OAUTH_REDIRECT_URI=https://maps.sistemaleme.com.br/api/google/callback
GOOGLE_INSIGHTS_SCOPES=https://www.googleapis.com/auth/business.manage
TOKEN_ENCRYPTION_SECRET=texto-grande-com-32-ou-mais-caracteres
```

Mantenha também as variáveis antigas do Radar Local.

## Importante

Não suba a pasta `data` para o GitHub. O volume persistente no EasyPanel deve continuar como `/app/data`.
