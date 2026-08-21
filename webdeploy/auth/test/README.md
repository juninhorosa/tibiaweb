# Teste do login web service

    node test/run.mjs ./server.js

Sobe o `server.js` de verdade com um banco falso no lugar do `mysql2`
(`loader.mjs` troca o modulo na resolucao) e confere a resposta contra o que
o cliente exige.

Existe porque este contrato quebra em silencio: se um campo sair errado, o
cliente nao diz qual -- mostra so "Unknown error" ou uma lista de personagens
vazia, e o rastro leva a um rebuild de uma hora para descobrir. Os campos e os
lugares de onde vieram estao anotados no `server.js`.
