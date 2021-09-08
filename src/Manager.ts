import { Replicant } from './Replicant'
import { ReplicantOptions } from 'nodecg/types/lib/replicant'

export class Manager {
  socket: SocketIOClient.Socket
  bundleName: string

  constructor (socket: SocketIOClient.Socket, bundleName: string) {
    this.socket = socket
    this.bundleName = bundleName
    this.socket.emit('joinRoom', this.bundleName)
  }

  newReplicant<V> (name: string, opts: ReplicantOptions<V> = {}) {
    return new Replicant<V>(name, this.bundleName, opts, this.socket)
  }
}
