const connections = new Map();
export function addConnection(response,workspaceId){if(!connections.has(workspaceId))connections.set(workspaceId,new Set());const set=connections.get(workspaceId);set.add(response);return()=>{set.delete(response);if(!set.size)connections.delete(workspaceId)}}
export function publish(workspaceId,event,data){for(const response of connections.get(workspaceId)||[])response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)}
export function keepAlive(){for(const set of connections.values())for(const response of set)response.write(': keep-alive\n\n')}
