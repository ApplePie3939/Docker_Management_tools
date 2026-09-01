import Docker from 'dockerode';

const socketPath = process.env.DOCKER_SOCKET ||
  (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock');

export const docker = new Docker({ socketPath });

export function toUserError(error, action = 'Dockerへの接続') {
  const detail = error?.reason || error?.json?.message || error?.message || String(error);
  const unavailable = /ENOENT|ECONNREFUSED|ECONNRESET|EPERM|EACCES|npipe|socket/i.test(detail);
  return {
    message: detail,
    guidance: unavailable
      ? 'Docker Desktop / Docker Engine が起動しているか、現在のユーザーに Docker へのアクセス権があるか確認してください。'
      : `${action}に失敗しました。対象コンテナの状態と Docker Engine のログを確認してください。`
  };
}

function ports(ports = {}) {
  return Object.entries(ports).flatMap(([containerPort, bindings]) =>
    (bindings || []).map((binding) => ({ containerPort, hostIp: binding.HostIp || '', hostPort: binding.HostPort || '' }))
  );
}

export function serializeContainer(container) {
  return {
    id: container.Id,
    name: (container.Names?.[0] || '').replace(/^\//, ''),
    image: container.Image,
    state: container.State,
    status: container.Status,
    ports: (container.Ports || []).map((port) => ({
      privatePort: port.PrivatePort,
      publicPort: port.PublicPort,
      type: port.Type,
      ip: port.IP
    }))
  };
}

export function serializeComposeProjects(containers) {
  const projects = new Map();
  for (const container of containers) {
    const name = container.Labels?.['com.docker.compose.project'];
    if (!name) continue;
    const item = serializeContainer(container);
    const project = projects.get(name) || { name, containers: [], running: 0, stopped: 0 };
    project.containers.push(item);
    if (item.state === 'running') project.running += 1;
    else project.stopped += 1;
    projects.set(name, project);
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getContainerDetail(id) {
  const data = await docker.getContainer(id).inspect();
  return {
    id: data.Id,
    name: data.Name.replace(/^\//, ''),
    image: data.Config.Image,
    state: data.State.Status,
    environment: data.Config.Env || [],
    ports: ports(data.HostConfig.PortBindings),
    mounts: (data.Mounts || []).map(({ Type, Source, Destination, Mode, RW }) => ({ type: Type, source: Source, destination: Destination, mode: Mode, writable: RW })),
  };
}
