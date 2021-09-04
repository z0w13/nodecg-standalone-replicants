import { Replicant } from './Replicant'

export default class Manager {
  socket: SocketIOClient.Socket
  bundleName: string

  constructor (socket: SocketIOClient.Socket, bundleName: string) {
    this.socket = socket
    this.bundleName = bundleName
    this.socket.emit('joinRoom', this.bundleName)
  }

  newReplicant<V> (name: string) {
    return new Replicant<V>(name, this.bundleName, {}, this.socket)
  }
}
