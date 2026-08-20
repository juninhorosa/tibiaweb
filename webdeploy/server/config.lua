-- gerado por webdeploy/tunnel/start.mjs
-- o hostname muda a cada restart do quick tunnel; rode o script de novo
-- e reinicie o canary quando isso acontecer.

ip = "wives-beef-teachers-major.trycloudflare.com"
loginProtocolPort = 7171
gameProtocolPort = 443
statusProtocolPort = 7171

mysqlHost = "mariadb"
mysqlUser = "canary"
mysqlPass = "canary"
mysqlDatabase = "canary"
mysqlPort = 3306
