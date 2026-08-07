#!/usr/bin/env bash
# Installe la seule dependance de slide-shot : poppler (pdftoppm + pdfinfo).
# Concu pour etre lance par quelqu'un qui recoit ce dossier et n'a rien configure.

set -u

BREW_DIRS=("/opt/homebrew/bin" "/usr/local/bin" "/usr/bin")

trouve_binaire() {
  local nom="$1"
  if command -v "$nom" >/dev/null 2>&1; then
    command -v "$nom"
    return 0
  fi
  local dossier
  for dossier in "${BREW_DIRS[@]}"; do
    if [ -x "$dossier/$nom" ]; then
      echo "$dossier/$nom"
      return 0
    fi
  done
  return 1
}

echo ""
echo "  slide-shot — verification des prerequis"
echo "  ---------------------------------------"
echo ""

# --- Node ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "  [X] Node.js est introuvable."
  echo ""
  echo "      slide-shot a besoin de Node.js 18 ou plus recent."
  echo "      Installe-le depuis https://nodejs.org (choisis la version LTS),"
  echo "      puis relance : npm run setup"
  echo ""
  exit 1
fi

VERSION_NODE_MAJEURE="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$VERSION_NODE_MAJEURE" -lt 18 ]; then
  echo "  [X] Node.js $(node -v) est trop ancien (il faut la version 18 minimum)."
  echo "      Mets-le a jour depuis https://nodejs.org puis relance : npm run setup"
  echo ""
  exit 1
fi
echo "  [OK] Node.js $(node -v)"

# --- poppler ------------------------------------------------------------
PDFTOPPM="$(trouve_binaire pdftoppm || true)"
PDFINFO="$(trouve_binaire pdfinfo || true)"

if [ -n "$PDFTOPPM" ] && [ -n "$PDFINFO" ]; then
  echo "  [OK] poppler ($PDFTOPPM)"
  echo ""
  echo "  Tout est pret. Lance l'application avec :"
  echo ""
  echo "      npm start"
  echo ""
  exit 0
fi

echo "  [!] poppler est manquant — c'est lui qui convertit les slides en images."
echo ""

# --- Homebrew -----------------------------------------------------------
BREW=""
if command -v brew >/dev/null 2>&1; then
  BREW="$(command -v brew)"
elif [ -x /opt/homebrew/bin/brew ]; then
  BREW="/opt/homebrew/bin/brew"
elif [ -x /usr/local/bin/brew ]; then
  BREW="/usr/local/bin/brew"
fi

if [ -z "$BREW" ]; then
  echo "  Homebrew est necessaire pour l'installer, et il est absent lui aussi."
  echo ""
  echo "  1. Installe Homebrew en collant cette ligne dans le Terminal :"
  echo ""
  echo '     /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  echo ""
  echo "  2. Puis reviens ici et relance : npm run setup"
  echo ""
  exit 1
fi

echo "  Installation de poppler via Homebrew (quelques minutes la premiere fois)..."
echo ""
if ! "$BREW" install poppler; then
  echo ""
  echo "  [X] L'installation a echoue."
  echo "      Reessaie a la main : brew install poppler"
  echo ""
  exit 1
fi

PDFTOPPM="$(trouve_binaire pdftoppm || true)"
PDFINFO="$(trouve_binaire pdfinfo || true)"

if [ -z "$PDFTOPPM" ] || [ -z "$PDFINFO" ]; then
  echo ""
  echo "  [X] poppler s'est installe mais reste introuvable."
  echo "      Ouvre un nouveau Terminal et relance : npm run setup"
  echo ""
  exit 1
fi

echo ""
echo "  [OK] poppler installe ($PDFTOPPM)"
echo ""
echo "  Tout est pret. Lance l'application avec :"
echo ""
echo "      npm start"
echo ""
