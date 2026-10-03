'use strict';
const os = require('os');

const name = process.platform; // 'linux' | 'win32' | 'darwin' | ...

module.exports = {
  name,
  isLinux: name === 'linux',
  isWindows: name === 'win32',
  isMac: name === 'darwin',
  isUnix: name !== 'win32',
  hostname: () => os.hostname(),
  username: () => { try { return os.userInfo().username; } catch { return 'user'; } },
  label: () => ({ linux: 'Linux', win32: 'Windows', darwin: 'macOS' }[name] || name),
  release: () => `${os.type()} ${os.release()}`,
};
