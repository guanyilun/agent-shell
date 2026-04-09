# Troubleshooting

## Agent Connection Issues

**Problem**: "Agent not connected. Please wait a moment and try again."

**Solutions**:
1. **Check agent installation**:
   ```bash
   which pi-acp
   which claude-agent-acp
   ```

2. **Verify ACP compatibility**:
   ```bash
   # Test if agent supports ACP protocol
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"test","version":"1.0.0"},"clientCapabilities":{"terminal":true,"fs":{"readTextFile":true,"writeTextFile":true}}}}' | pi-acp
   ```

3. **Install missing agents**:
   ```bash
   npm install -g pi-acp
   npm install -g @agentclientprotocol/claude-agent-acp
   ```

4. **Check environment variables**:
   ```bash
   echo $ANTHROPIC_API_KEY
   echo $OPENAI_API_KEY
   echo $GEMINI_API_KEY
   ```

## Common Errors

**Error**: "claude: command not found"
- **Cause**: Trying to use `claude` CLI tool which doesn't support ACP
- **Solution**: Use `claude-agent-acp` or `pi-acp` instead

**Error**: "API key not found"
- **Cause**: Missing required API key environment variable
- **Solution**: Set the appropriate API key (e.g., `export ANTHROPIC_API_KEY="your-key"`)

**Error**: "Invalid model name"
- **Cause**: Using incorrect model name
- **Solution**: Use valid model names like `claude-3-5-sonnet-20241022` or `gpt-4o`

**Error**: "Agent process exited with code X"
- **Cause**: Agent crashed or failed to start
- **Solution**: Check agent installation and API key validity

## Debug Mode

Enable debug mode to see detailed ACP protocol information:
```bash
DEBUG=1 npm start -- --agent pi-acp
```

## Getting Help

If you encounter issues:
1. Check the [ACP Protocol Documentation](https://agentclientprotocol.com/)
2. Verify agent installation: `pi-acp --version` or `claude-agent-acp --version`
3. Test with different agents to isolate the problem
4. Check GitHub issues for known problems
