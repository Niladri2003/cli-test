const cliOptions = {
  // SSH-like options
  R: { type: 'string', multiple: true, description: 'Local port. Eg. -R0:localhost:3000 will forward tunnel connections to local port 3000.' },
  L: { type: 'string', multiple: true, description: 'Web Debugger address. Eg. -L4300:localhost:4300 will start web debugger on port 4300.' },
  o: { type: 'string', multiple: true, description: 'Options', hidden: true },
  'server-port': { type: 'string', short: 'p', description: 'Pinggy server port. Default: 443' },

  v4: { type: 'boolean', short: '4', description: 'IPv4 only', hidden: true },
  v6: { type: 'boolean', short: '6', description: 'IPv6 only', hidden: true },

  // These options appear in the ssh command, but we ignore it in CLI
  t: { type: 'boolean', description: 'hidden', hidden: true },
  T: { type: 'boolean', description: 'hidden', hidden: true },
  n: { type: 'boolean', description: 'hidden', hidden: true },
  N: { type: 'boolean', description: 'hidden', hidden: true },

  // Better options
  type: { type: 'string', description: 'Type of the connection. Eg. --type tcp' },
  localport: { type: 'string', short: 'l', description: 'Takes input as [protocol:][host:]port. Eg. --localport https://localhost:8000 OR -l 3000' },
  debugger: { type: 'string', short: 'd', description: 'Port for web debugger. Eg. --debugger 4300 OR -d 4300' },
  token: { type: 'string', description: 'Token for authentication. Eg. --token TOKEN_VALUE' },

  // Logging options (CLI overrides env)
  loglevel: { type: 'string', description: 'Logging level: ERROR, INFO, DEBUG. Overrides PINGGY_LOG_LEVEL environment variable' },
  logfile: { type: 'string', description: 'Path to log file. Overrides PINGGY_LOG_FILE environment variable' },
  v: { type: 'boolean', description: 'Print logs to stdout for Cli. Overrides PINGGY_LOG_STDOUT environment variable' },
  vv: { type: 'boolean', description: 'Enable detailed logging for the Node.js SDK and Libpinggy, including both info and debug level logs.' },
  vvv: { type: 'boolean', description: 'Enable all logs from Cli, SDK and internal components.' },

  autoreconnect: { type: 'boolean', short :'a', description: 'Automatically reconnect tunnel on failure.' },

  // Save and load config
  saveconf: { type: 'string', description: 'Create the configuration file based on the options provided here' },
  conf: { type: 'string', description: 'Use the configuration file as base. Other options will be used to override this file' },

  // File server
  serve: { type: 'string', description: 'Start a webserver to serve files from the specified path. Eg --serve /path/to/files' },

  // Remote Control
  'remote-management': { type: 'string', description: 'Enable remote management of tunnels with token. Eg. --remote-management API_KEY' },
  manage: { type: 'string', description: 'Provide a server address to manage tunnels. Eg --manage dashboard.pinggy.io' },
  notui: { type: 'boolean', description: 'Disable TUI in remote management mode' },
  // Misc
  version: { type: 'boolean', description: 'Print version' },

  // Help
  help: { type: 'boolean', short: 'h', description: 'Show this help message' },
};

module.exports = { cliOptions };
