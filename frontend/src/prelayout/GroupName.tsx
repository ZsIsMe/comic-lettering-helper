import { groupColor } from './group-colors'

export function GroupName({ name, index }: { name: string; index: number }) {
  return <span className="pl-group-name"><span className="pl-group-square" aria-hidden="true" style={{ color: groupColor(index) }}>■</span>{name}</span>
}
