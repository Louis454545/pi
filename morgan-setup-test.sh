#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

KEEP=false
NO_ENV=false
LAUNCH=false
ARGS=()

for arg in "$@"; do
	case "$arg" in
		--keep)
			KEEP=true
			;;
		--no-env)
			NO_ENV=true
			;;
		--launch)
			LAUNCH=true
			;;
		*)
			ARGS+=("$arg")
			;;
	esac
done

if [[ "$NO_ENV" == "true" ]]; then
	# Unset API keys (see packages/ai/src/env-api-keys.ts)
	unset ANTHROPIC_API_KEY
	unset ANTHROPIC_OAUTH_TOKEN
	unset OPENAI_API_KEY
	unset GEMINI_API_KEY
	unset GROQ_API_KEY
	unset CEREBRAS_API_KEY
	unset XAI_API_KEY
	unset OPENROUTER_API_KEY
	unset ZAI_API_KEY
	unset MISTRAL_API_KEY
	unset MINIMAX_API_KEY
	unset MINIMAX_CN_API_KEY
	unset AI_GATEWAY_API_KEY
	unset OPENCODE_API_KEY
	unset COPILOT_GITHUB_TOKEN
	unset GH_TOKEN
	unset GITHUB_TOKEN
	unset HF_TOKEN
	unset GOOGLE_APPLICATION_CREDENTIALS
	unset GOOGLE_CLOUD_PROJECT
	unset GCLOUD_PROJECT
	unset GOOGLE_CLOUD_LOCATION
	unset AWS_PROFILE
	unset AWS_ACCESS_KEY_ID
	unset AWS_SECRET_ACCESS_KEY
	unset AWS_SESSION_TOKEN
	unset AWS_REGION
	unset AWS_DEFAULT_REGION
	unset AWS_BEARER_TOKEN_BEDROCK
	unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
	unset AWS_CONTAINER_CREDENTIALS_FULL_URI
	unset AWS_WEB_IDENTITY_TOKEN_FILE
	unset AZURE_OPENAI_API_KEY
	unset AZURE_OPENAI_BASE_URL
	unset AZURE_OPENAI_RESOURCE_NAME
	echo "Running without API keys..."
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/morgan-setup-test.XXXXXX")"
export MORGAN_AGENT_DIR="$TEMP_DIR/agent"
export MORGAN_SESSION_DIR="$TEMP_DIR/sessions"
export UV_TOOL_DIR="$TEMP_DIR/uv-tools"
export UV_TOOL_BIN_DIR="$TEMP_DIR/uv-bin"
export UV_LINK_MODE="${UV_LINK_MODE:-copy}"
export PATH="$UV_TOOL_BIN_DIR:$PATH"

cleanup() {
	local status=$?
	if [[ "$KEEP" == "true" || "$status" -ne 0 ]]; then
		echo "Setup test sandbox kept: $TEMP_DIR"
	else
		rm -rf "$TEMP_DIR"
	fi
}
trap cleanup EXIT

echo "Setup test sandbox: $TEMP_DIR"
echo "MORGAN_AGENT_DIR: $MORGAN_AGENT_DIR"
echo "UV_TOOL_DIR: $UV_TOOL_DIR"
echo "UV_TOOL_BIN_DIR: $UV_TOOL_BIN_DIR"

CMD=(
	"$SCRIPT_DIR/node_modules/.bin/tsx"
	--tsconfig "$SCRIPT_DIR/tsconfig.json"
	"$SCRIPT_DIR/packages/morgan-agent/src/cli.ts"
	setup
)

if [[ "$LAUNCH" != "true" ]]; then
	CMD+=(--no-launch)
fi

"${CMD[@]}" ${ARGS[@]+"${ARGS[@]}"}
