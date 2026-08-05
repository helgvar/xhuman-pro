#!/bin/zsh
# 📱 CLAUDE DA CELLULARE — avvia (o riattacca) la sessione Claude Code in tmux.
#
# Sul Mac:   ./claude-mobile.sh        → la sessione vive in tmux "claude"
# Dal cell:  Termius/Blink → SSH al Mac (via Tailscale) → ./claude-mobile.sh
#            e ti ritrovi ESATTAMENTE nella stessa sessione, stessa memoria,
#            stesso accesso alla produzione. Per staccare senza chiudere:
#            Ctrl+B poi D. La sessione continua a girare.
cd "$(dirname "$0")"
if /opt/homebrew/bin/tmux has-session -t claude 2>/dev/null; then
  exec /opt/homebrew/bin/tmux attach -t claude
else
  exec /opt/homebrew/bin/tmux new-session -s claude "claude --continue || claude"
fi
