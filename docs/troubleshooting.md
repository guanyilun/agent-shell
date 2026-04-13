# Troubleshooting

## Common Issues

**Problem**: No response from agent (thinking appears but no text)

**Solutions**:
1. Check API key: `echo $OPENAI_API_KEY`
2. Test the API endpoint directly:
   ```bash
   curl -s "$OPENAI_BASE_URL/models" -H "Authorization: Bearer $OPENAI_API_KEY" | head
   ```
3. Verify the model name is correct for your provider

**Problem**: "context overflow" or response cut off

**Solution**: The conversation is too long. Use `/compact` to manually free up space, or the agent will auto-compact after the error.

**Problem**: Tool calls not working (agent responds but doesn't use tools)

**Solution**: Some models have limited or no tool/function calling support. Try a more capable model (e.g., gpt-4o, claude-sonnet-4-6 via OpenRouter).

**Problem**: Garbled output, startup banner overwritten, or messy prompt rendering

**Cause**: Powerlevel10k's **instant prompt** feature races with agent-sh's TUI. Instant prompt caches the previous prompt, displays it immediately, redirects stdout/stderr during shell init, then redraws the prompt using cursor-movement sequences — all of which can overwrite agent-sh's output.

**Solution**: Guard the instant prompt block in your `~/.zshrc` so it's skipped inside agent-sh:

```zsh
# Disable p10k instant prompt inside agent-sh (it races with TUI rendering)
if [[ -z "$AGENT_SH" && -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi
```

Your normal p10k prompt still works — only the "flash cached prompt then redraw" behavior is disabled.

## Common Errors

**Error**: "API key not found" or "401 Unauthorized"
- **Cause**: Missing or invalid API key
- **Solution**: Set the appropriate key: `export OPENAI_API_KEY="your-key"`

**Error**: "Invalid model name" or "404 Not Found"
- **Cause**: Model not available at the configured endpoint
- **Solution**: Check available models for your provider. Local providers (Ollama, LM Studio) need the model downloaded first.

**Error**: Stream errors or disconnections
- **Cause**: Network issues or provider rate limits
- **Solution**: The agent will show the error. Try again, or check provider status.

## Debug Mode

Enable debug mode for detailed protocol logging:

```bash
DEBUG=1 agent-sh --api-key "$KEY" --model gpt-4o
```

## Getting Help

If you encounter issues:
1. Check the [Usage Guide](usage.md) for provider configuration
2. Try a different model or provider to isolate the problem
3. Check [GitHub issues](https://github.com/guanyilun/agent-sh/issues) for known problems
