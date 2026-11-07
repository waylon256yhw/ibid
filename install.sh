#!/usr/bin/env bash
set -euo pipefail

platform=$(uname -ms)

if [[ ${OS:-} = Windows_NT ]]; then
  if [[ $platform != MINGW64* ]]; then
    powershell -c "irm https://raw.githubusercontent.com/waylon256yhw/ibid/main/install.ps1|iex"
    exit $?
  fi
fi

Color_Off=''
Red=''
Green=''
Dim=''
Bold_White=''
Bold_Green=''

if [[ -t 1 ]]; then
  Color_Off='\033[0m'
  Red='\033[0;31m'
  Green='\033[0;32m'
  Dim='\033[0;2m'
  Bold_Green='\033[1;32m'
  Bold_White='\033[1m'
fi

error() {
  echo -e "${Red}error${Color_Off}:" "$@" >&2
  exit 1
}

info() {
  echo -e "${Dim}$*${Color_Off}"
}

info_bold() {
  echo -e "${Bold_White}$*${Color_Off}"
}

success() {
  echo -e "${Green}$*${Color_Off}"
}

command -v curl >/dev/null ||
  error 'curl is required to install ibid'

command -v unzip >/dev/null ||
  error 'unzip is required to install ibid'

if [[ $# -gt 1 ]]; then
  error 'Too many arguments, only 1 is allowed (an optional release tag such as "v0.1.0")'
fi

case $platform in
'Darwin x86_64')
  target=darwin-x64
  ;;
'Darwin arm64')
  target=darwin-aarch64
  ;;
'Linux aarch64' | 'Linux arm64')
  target=linux-aarch64
  ;;
'MINGW64'*'ARM64'* | 'MINGW64'*'aarch64'*)
  target=windows-aarch64
  ;;
'MINGW64'*)
  target=windows-x64
  ;;
'Linux x86_64')
  target=linux-x64
  ;;
*)
  error "Unsupported platform: $platform"
  ;;
esac

case "$target" in
'linux'*)
  if [[ -f /etc/alpine-release ]]; then
    target="$target-musl"
  fi
  ;;
esac

if [[ $target = darwin-x64 ]]; then
  if [[ $(sysctl -n sysctl.proc_translated 2>/dev/null || true) = 1 ]]; then
    target=darwin-aarch64
    info "Your shell is running in Rosetta 2. Downloading ibid for $target instead"
  fi
fi

GITHUB=${GITHUB-"https://github.com"}
github_repo="$GITHUB/waylon256yhw/ibid"

exe_name=ibid
case "$target" in
'windows'*)
  exe_name=ibid.exe
  ;;
esac

if [[ $# = 0 ]]; then
  ibid_uri=$github_repo/releases/latest/download/ibid-$target.zip
else
  version=$1
  if [[ $version != v* ]]; then
    version="v$version"
  fi
  ibid_uri=$github_repo/releases/download/$version/ibid-$target.zip
fi

bin_dir=${IBID_INSTALL_DIR:-$HOME/.local/bin}
exe=$bin_dir/$exe_name

if [[ ! -d $bin_dir ]]; then
  mkdir -p "$bin_dir" ||
    error "Failed to create install directory \"$bin_dir\""
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/ibid-install.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

curl --fail --location --progress-bar --output "$tmp_dir/ibid.zip" "$ibid_uri" ||
  error "Failed to download ibid from \"$ibid_uri\""

unzip -oqd "$tmp_dir" "$tmp_dir/ibid.zip" ||
  error 'Failed to extract ibid archive'

if [[ -f "$tmp_dir/ibid-$target/$exe_name" ]]; then
  extracted="$tmp_dir/ibid-$target/$exe_name"
elif [[ -f "$tmp_dir/$exe_name" ]]; then
  extracted="$tmp_dir/$exe_name"
else
  error "Archive did not contain expected binary \"$exe_name\""
fi

mv "$extracted" "$exe" ||
  error 'Failed to move extracted ibid binary to destination'

chmod +x "$exe" ||
  error 'Failed to set executable permissions on ibid'

tildify() {
  if [[ $1 = $HOME/* ]]; then
    local replacement=\~/
    echo "${1/$HOME\//$replacement}"
  else
    echo "$1"
  fi
}

success "ibid was installed successfully to $Bold_Green$(tildify "$exe")"

if [[ ":$PATH:" == *":$bin_dir:"* ]]; then
  echo "Run 'ibid --help' to get started"
  exit 0
fi

if [[ ${IBID_NO_MODIFY_PATH:-0} = 1 ]]; then
  echo "Add $(tildify "$bin_dir") to your PATH to use 'ibid' directly"
  exit 0
fi

tilde_bin_dir=$(tildify "$bin_dir")
quoted_bin_dir=\"${bin_dir//\"/\\\"}\"
if [[ $quoted_bin_dir = \"$HOME/* ]]; then
  quoted_bin_dir=${quoted_bin_dir/$HOME\//\$HOME/}
fi

echo

case $(basename "${SHELL:-}") in
fish)
  command_str="fish_add_path $tilde_bin_dir"
  fish_config=$HOME/.config/fish/config.fish
  tilde_fish_config=$(tildify "$fish_config")

  if [[ -w $fish_config ]] || [[ ! -e $fish_config && -w $(dirname "$fish_config") ]]; then
    mkdir -p "$(dirname "$fish_config")"
    if ! grep -Fq "$tilde_bin_dir" "$fish_config" 2>/dev/null && ! grep -Fq "$bin_dir" "$fish_config" 2>/dev/null; then
      {
        echo -e '\n# ibid'
        echo "$command_str"
      } >>"$fish_config"
      info "Added \"$tilde_bin_dir\" to \$PATH in \"$tilde_fish_config\""
    fi
    echo "To get started, run:"
    info_bold "  source $tilde_fish_config"
    info_bold "  ibid --help"
  else
    echo "Manually add the directory to $tilde_fish_config (or similar):"
    info_bold "  $command_str"
  fi
  ;;
zsh)
  command_str="export PATH=$quoted_bin_dir:\$PATH"
  zsh_config=$HOME/.zshrc
  tilde_zsh_config=$(tildify "$zsh_config")

  if [[ -w $zsh_config ]] || [[ ! -e $zsh_config && -w $HOME ]]; then
    if ! grep -Fq "$bin_dir" "$zsh_config" 2>/dev/null && ! grep -Fq "${bin_dir/#$HOME/\$HOME}" "$zsh_config" 2>/dev/null; then
      {
        echo -e '\n# ibid'
        echo "$command_str"
      } >>"$zsh_config"
      info "Added \"$tilde_bin_dir\" to \$PATH in \"$tilde_zsh_config\""
    fi
    echo "To get started, run:"
    info_bold "  exec \$SHELL"
    info_bold "  ibid --help"
  else
    echo "Manually add the directory to $tilde_zsh_config (or similar):"
    info_bold "  $command_str"
  fi
  ;;
bash)
  command_str="export PATH=$quoted_bin_dir:\$PATH"
  bash_configs=(
    "$HOME/.bashrc"
    "$HOME/.bash_profile"
  )
  if [[ ${XDG_CONFIG_HOME:-} ]]; then
    bash_configs+=(
      "$XDG_CONFIG_HOME/.bash_profile"
      "$XDG_CONFIG_HOME/.bashrc"
      "$XDG_CONFIG_HOME/bash_profile"
      "$XDG_CONFIG_HOME/bashrc"
    )
  fi

  set_manually=true
  for bash_config in "${bash_configs[@]}"; do
    tilde_bash_config=$(tildify "$bash_config")
    if [[ -w $bash_config ]]; then
      if ! grep -Fq "$bin_dir" "$bash_config" 2>/dev/null && ! grep -Fq "${bin_dir/#$HOME/\$HOME}" "$bash_config" 2>/dev/null; then
        {
          echo -e '\n# ibid'
          echo "$command_str"
        } >>"$bash_config"
        info "Added \"$tilde_bin_dir\" to \$PATH in \"$tilde_bash_config\""
      fi
      set_manually=false
      echo "To get started, run:"
      info_bold "  source $tilde_bash_config"
      info_bold "  ibid --help"
      break
    fi
  done

  if [[ $set_manually = true ]]; then
    echo "Manually add the directory to ~/.bashrc (or similar):"
    info_bold "  $command_str"
  fi
  ;;
*)
  echo 'Manually add the directory to ~/.bashrc (or similar):'
  info_bold "  export PATH=$quoted_bin_dir:\$PATH"
  ;;
esac
