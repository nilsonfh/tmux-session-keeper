# tmux Session Keeper

Gestiona desde un panel de VS Code tus sesiones de [Claude Code](https://claude.com/claude-code) que viven en **tmux** y su **Remote Control**.

> No es un producto oficial de Anthropic. "Claude" es marca de Anthropic, PBC.

English: [README.md](README.md)

## Para qué
Las sesiones de Claude Code abiertas en una terminal normal mueren al cerrar VS Code o SSH. Dentro de tmux sobreviven, pero
entonces hay que manejar a mano `tmux ls`, índices de ventana, ids de conversación y el flag `--remote-control`. Esta extensión
lo reúne en un panel.

## Funciones
- **Árbol:** servicios systemd → sesiones tmux → ventanas, con el estado de Remote Control de cada una.
- **Aviso de duplicado:** marca una conversación abierta en más de un proceso (la causa del error 4090 de Remote Control).
- **Abrir** una ventana en el terminal integrado.
- **Nueva sesión o retomar** una conversación guardada (`--resume`), con o sin Remote Control.
- **Reconectar Remote Control** escribiendo `/remote-control` en la ventana (pide confirmación).
- **Volver tras un reinicio:** marca ventanas para recrearlas al reiniciar el servidor, de cualquier proyecto (cada una con su directorio).
  Un comando instala el servicio systemd de usuario. No hace falta `jq` ni `python`.
- **Servidor de Remote Control:** configura `claude remote-control` como servicio que se reinicia solo si termina (corte de red, etc.)
  y arranca con el servidor, para crear sesiones nuevas desde la app móvil de Claude o claude.ai/code. Un servidor por proyecto,
  con asistente para las dos preguntas de la primera vez, visor de log y comando para quitarlo.
- **Importar ventanas en marcha** a la lista de arranque.
- Iniciar, reiniciar o detener el servicio. Cerrar una ventana (pide confirmación; la conversación queda guardada).

## Requisitos
- Linux con `tmux` y `systemd --user` (el arranque tras reinicio necesita systemd; lo demás funciona solo con tmux).
- Claude Code (`claude`) en el `PATH`, o define `tmuxKeeper.claudeBin`.
- VS Code conectado a la máquina donde corren las sesiones (local o Remote-SSH).
- Para arrancar sin iniciar sesión, activa el linger una vez: `sudo loginctl enable-linger $USER`. La extensión avisa si falta y nunca ejecuta `sudo` por ti.

## Instalación
Descarga el último `.vsix` desde [Releases](https://github.com/nilsonfh/tmux-session-keeper/releases) e instálalo. Ejecuta esto en el terminal de la máquina donde corren tus sesiones (con Remote-SSH, el terminal remoto):

    curl -fsSL -o /tmp/tmux-session-keeper.vsix https://github.com/nilsonfh/tmux-session-keeper/releases/latest/download/tmux-session-keeper.vsix \
      && code --install-extension /tmp/tmux-session-keeper.vsix

`code --install-extension` solo acepta un archivo local o un id del Marketplace, no una URL, así que son dos pasos. Cada release publica el SHA-256 del archivo en sus notas. Para fijar una versión usa `.../releases/download/vX.Y.Z/tmux-session-keeper-X.Y.Z.vsix`. Después recarga la ventana de VS Code.

## Primeros pasos
1. Abre el panel **Session Keeper** en la barra de actividad.
2. Pulsa **+**, elige una conversación (o una nueva) y nombra la ventana.
3. Responde **Sí** a "¿Debe volver tras un reinicio?" en las sesiones que quieras conservar.
4. Una sola vez, ejecuta **Session Keeper: Instalar servicio de arranque** desde la paleta de comandos.
5. Para crear sesiones desde el celular, ejecuta **Session Keeper: Configurar un servidor de Remote Control**. Tu login de `claude`
   debe ser una cuenta de claude.ai (`claude auth login`); `setup-token` y `CLAUDE_CODE_OAUTH_TOKEN` no sirven para Remote Control.

## Privacidad y seguridad
- Todo queda en tu máquina; la extensión no hace llamadas de red.
- Solo lee **id, fecha y título** de las conversaciones en `~/.claude/projects/<proyecto>/*.jsonl`. No lee credenciales.
- Ejecuta `tmux`, `ps`, `systemctl --user` y `loginctl` sin shell. Las acciones que escriben en una sesión o la terminan piden confirmación.

## Límites conocidos
- Detener un servidor termina las sesiones que sirve (las conversaciones quedan guardadas). La extensión no puede validar tu login: si es incorrecto, el servidor se reinicia en bucle y lo ves en **Ver log**.
- El estado de Remote Control se **deduce de las últimas 300 líneas del panel**; si el mensaje ya salió de pantalla aparece "sin confirmar".
  Una versión futura de Claude Code puede cambiar los textos. Lo definitivo está en la app de Claude o en claude.ai/code.

Licencia: MIT.
