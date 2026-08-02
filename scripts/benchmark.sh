#!/bin/bash
# Token Usage Benchmark Script for open-codebase-index
# Compares token usage with and without the plugin across different codebase sizes

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DEMO_REPOS_DIR="$HOME/dev/git/demo-repos"
RESULTS_DIR="$PROJECT_ROOT/benchmark-results"
MODEL="github-copilot/gpt-5-mini"

# Test query - conceptual search that benefits from semantic understanding
TEST_QUERY="find the code that handles HTTP request errors and show me how errors are processed"

# Repos to test (small, medium, large)
REPOS=("axios" "express" "nextjs")

# Create results directory
mkdir -p "$RESULTS_DIR"

# Timestamp for this run
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_FILE="$RESULTS_DIR/benchmark_$TIMESTAMP.json"

echo "============================================"
echo "OpenCode Codebase Index Benchmark"
echo "============================================"
echo "Model: $MODEL"
echo "Query: $TEST_QUERY"
echo "Results: $RESULTS_FILE"
echo ""

# Initialize results JSON
echo '{"timestamp": "'$TIMESTAMP'", "model": "'$MODEL'", "query": "'$TEST_QUERY'", "results": []}' > "$RESULTS_FILE"

run_test() {
    local repo=$1
    local with_plugin=$2  # "true" or "false"
    local repo_path="$DEMO_REPOS_DIR/$repo"
    
    echo "Testing: $repo (plugin=$with_plugin)"
    
    # Configure opencode.json based on with_plugin flag
    if [ "$with_plugin" = "true" ]; then
        # Use canonical package name; opencode-codebase-index remains a legacy alias.
        echo '{"plugin": ["open-codebase-index"]}' > "$repo_path/opencode.json"
        
        # First, index the codebase if not already indexed
        echo "  Indexing codebase..."
        cd "$repo_path"
        opencode run "index the codebase" --format json --model "$MODEL" 2>&1 | tail -1 > /dev/null || true
    else
        echo '{"plugin": []}' > "$repo_path/opencode.json"
    fi
    
    # Run the test query
    echo "  Running query..."
    cd "$repo_path"
    
    # Capture output and extract token counts
    OUTPUT=$(opencode run "$TEST_QUERY" --format json --model "$MODEL" 2>&1)
    
    # Extract token counts from the step_finish event
    STEP_FINISH=$(echo "$OUTPUT" | grep '"type":"step_finish"' | tail -1)
    
    if [ -n "$STEP_FINISH" ]; then
        INPUT_TOKENS=$(echo "$STEP_FINISH" | jq -r '.part.tokens.input // 0')
        OUTPUT_TOKENS=$(echo "$STEP_FINISH" | jq -r '.part.tokens.output // 0')
        TOTAL_TOKENS=$((INPUT_TOKENS + OUTPUT_TOKENS))
        
        echo "  Input tokens: $INPUT_TOKENS"
        echo "  Output tokens: $OUTPUT_TOKENS"
        echo "  Total tokens: $TOTAL_TOKENS"
        
        # Count files in repo
        FILE_COUNT=$(find "$repo_path" -type f \( -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" \) | wc -l | tr -d ' ')
        
        RESULT="{\"repo\": \"$repo\", \"with_plugin\": $with_plugin, \"files\": $FILE_COUNT, \"input_tokens\": $INPUT_TOKENS, \"output_tokens\": $OUTPUT_TOKENS, \"total_tokens\": $TOTAL_TOKENS}"
        jq ".results += [$RESULT]" "$RESULTS_FILE" > "$RESULTS_FILE.tmp" && mv "$RESULTS_FILE.tmp" "$RESULTS_FILE"
    else
        echo "  ERROR: Could not extract token counts"
        echo "  Output: $OUTPUT"
    fi
    
    echo ""
}

# Run tests for each repo
for repo in "${REPOS[@]}"; do
    if [ -d "$DEMO_REPOS_DIR/$repo" ]; then
        # Test WITHOUT plugin first
        run_test "$repo" "false"
        
        # Test WITH plugin
        run_test "$repo" "true"
    else
        echo "WARNING: Repo $repo not found at $DEMO_REPOS_DIR/$repo"
    fi
done

echo "============================================"
echo "Results Summary"
echo "============================================"

# Display results summary
jq -r '.results | group_by(.repo) | .[] | 
    "Repo: \(.[0].repo) (\(.[0].files) files)\n" +
    "  Without plugin: \(.[] | select(.with_plugin == false) | .total_tokens) tokens\n" +
    "  With plugin:    \(.[] | select(.with_plugin == true) | .total_tokens) tokens\n" +
    "  Savings:        \(((.[] | select(.with_plugin == false) | .total_tokens) - (.[] | select(.with_plugin == true) | .total_tokens)) / (.[] | select(.with_plugin == false) | .total_tokens) * 100 | round)%\n"
' "$RESULTS_FILE"

echo ""
echo "Full results saved to: $RESULTS_FILE"
