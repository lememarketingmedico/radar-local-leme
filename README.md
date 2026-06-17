# Radar Local LEME V3.9

Correção da V3.9:

- corrige o erro de sessão `Não autenticado`;
- sessão agora é validada por cookie assinado, sem depender de memória do servidor;
- após rebuild/restart do EasyPanel, a sessão não quebra desde que `SESSION_SECRET` continue igual;
- quando a sessão realmente expira, o app volta para a tela de login em vez de quebrar o mapa;
- mantém ranking de concorrentes opcional e relatórios anteriores.

## Importante

Mantenha a variável `SESSION_SECRET` fixa no EasyPanel. Não deixe vazia e não mude entre versões.
Continue usando o volume persistente em `/app/data`.
Não suba a pasta `data` para o GitHub.
