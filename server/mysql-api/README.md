# MedCore MySQL API

Suba estes arquivos para `public_html/medcore-api` no cPanel.

Arquivos esperados no servidor:

- `index.php`
- `config.php`

Use `config.example.php` como base para criar `config.php`.

Depois de subir, teste:

```text
https://ghzplugin.com.br/medcore-api/index.php
```

A API responde apenas via `POST` autenticado com `X-MedCore-Token`, exceto quando acessada por navegador, onde mostra uma mensagem simples de status.

