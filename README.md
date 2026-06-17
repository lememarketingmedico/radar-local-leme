# Radar Local LEME V3.8

Atualização com ranking opcional de concorrentes.

## Novo nesta versão

- Mantém o relatório visual com grid completo.
- Adiciona a opção **Incluir ranking de concorrentes** na análise manual.
- Após rodar o grid com essa opção marcada, o resultado mostra os perfis concorrentes em ordem de posição média, com melhor posição, aparições e Top 10.
- O ranking de concorrentes também fica salvo no histórico da análise.

## Atenção sobre custo

A análise normal continua usando apenas IDs. O ranking de concorrentes precisa buscar `displayName`, então pode cair em SKU pago da Places API. Use essa opção quando precisar da lista, não em todas as automações.

## Deploy

Suba os arquivos da pasta para a raiz do GitHub e faça Forçar reconstrução no EasyPanel.

Mantenha o volume persistente em `/app/data` e não suba pasta `data` para o GitHub.
