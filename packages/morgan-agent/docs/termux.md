# Termux

Install Node.js, Git, and the optional Termux API tools:

```bash
pkg install nodejs git termux-api
npm install -g @earendil-works/morgan-agent
morgan
```

Morgan uses the Termux HOME as its fixed runtime directory. Clipboard integration uses `termux-clipboard-set` and `termux-clipboard-get` when Termux:API is installed. Image clipboard paste is not supported.
