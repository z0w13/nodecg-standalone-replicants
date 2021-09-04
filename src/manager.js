const Replicant = require('./replicant')

class Manager {
  constructor (socket, bundleName) {
    this.socket = socket
    this.bundleName = bundleName
    this.socket.emit('joinRoom', this.bundleName)
  }

  newReplicant (name) {
    return new Replicant(name, this.bundleName, {}, this.socket)
  }
}

module.exports = Manager
