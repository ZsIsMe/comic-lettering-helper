import { RasterWorkerClient } from './raster-worker-client'

/** One live editor worker per project; construction is lazy, never during React render. */
export class RasterWorkerOwner {
  private client: RasterWorkerClient | null = null
  constructor(private readonly create: () => RasterWorkerClient = () => new RasterWorkerClient()) {}
  readonly acquire = () => {
    const reused = !!this.client?.usable
    if (!reused) {
      this.client?.dispose()
      this.client = this.create()
    }
    return { client: this.client!, reused }
  }
  dispose() {
    this.client?.dispose()
    this.client = null
  }
}
