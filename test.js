const Replicant = require('./src/Replicant').Replicant
const io = require('socket.io-client')

const sock = io('http://localhost:9090')
const repl = new Replicant('break', 'nodecg-zowiettv', {}, sock)

global.repl = repl
