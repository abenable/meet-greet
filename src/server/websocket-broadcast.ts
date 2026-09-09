// WebSocket broadcasting utilities
// Supports both Bun server (production) and dev-mode Vite plugin

export interface WSMessage {
  type: 'chat_message' | 'match_created' | 'typing' | 'read_receipt' | 'online_status' | 'event_post' | 'error'
  payload: any
  timestamp: number
}

let bunServer: any = null

export function setBunServer(server: any) {
  bunServer = server
}

function getPublisher() {
  if (bunServer) return bunServer
  const dev = (globalThis as any).__devWSS__
  if (dev) return dev
  const prod = (globalThis as any).__bunServer__
  if (prod) return prod
  return null
}

export function broadcastToUser(userId: string, message: WSMessage) {
  const publisher = getPublisher()
  if (!publisher) {
    console.warn('WebSocket server not initialized for broadcasting')
    return
  }
  try {
    publisher.publish(`user:${userId}`, JSON.stringify(message))
  } catch (error) {
    console.error('Failed to broadcast to user:', error)
  }
}

export function broadcastToEvent(eventId: string, message: WSMessage) {
  const publisher = getPublisher()
  if (!publisher) {
    console.warn('WebSocket server not initialized for broadcasting')
    return
  }
  try {
    publisher.publish(`event:${eventId}`, JSON.stringify(message))
  } catch (error) {
    console.error('Failed to broadcast to event:', error)
  }
}

export function broadcastChatMessage(chatId: string, message: any, recipientId: string) {
  const wsMessage: WSMessage = {
    type: 'chat_message',
    payload: { chatId, message },
    timestamp: Date.now(),
  }
  
  broadcastToUser(recipientId, wsMessage)
}

export function broadcastMatchCreated(eventId: string | null, user1Id: string, user2Id: string, matchId: string) {
  const wsMessage1: WSMessage = {
    type: 'match_created',
    payload: { eventId, matchId, peerId: user2Id },
    timestamp: Date.now(),
  }
  
  const wsMessage2: WSMessage = {
    type: 'match_created',
    payload: { eventId, matchId, peerId: user1Id },
    timestamp: Date.now(),
  }
  
  broadcastToUser(user1Id, wsMessage1)
  broadcastToUser(user2Id, wsMessage2)
}

export function broadcastReadReceipt(chatId: string, userId: string, messageId: string, recipientId: string) {
  const wsMessage: WSMessage = {
    type: 'read_receipt',
    payload: { chatId, userId, messageId },
    timestamp: Date.now(),
  }
  
  broadcastToUser(recipientId, wsMessage)
}
