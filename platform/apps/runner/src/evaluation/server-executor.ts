// The server's `EvalExecutor` (task L04, design/ADR-M81 §2.1): the same interface as the developer
// machine's `LocalExecutor`, so the scoring and the result are the same code in both places. It is
// made for one evaluation run: the scoring containers are named from the run, and the hardware is
// the runner's (instance label included).
import {
  describeHardware,
  type EvalExecutor,
  type ExecutionPlace,
  type HardwareInfo,
  type Score,
  type ScoringRequest,
} from '@sdlc/eval';

import type { DockerClient } from '../docker/client.js';
import type { RunnerSettings } from '../settings.js';
import { scoreEvaluationRun, type ScoreEvaluationInput } from './score.js';

export interface ServerExecutorOptions {
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  /** The evaluation run these scoring containers belong to. */
  readonly runId: string;
  readonly tenantId: string;
  /** The project's sandbox image, by digest. */
  readonly image: string;
  /** The pinned commit's tree as files, and the task's hidden tests. */
  readonly treeDir: string;
  readonly hiddenDir: string;
}

export class ServerExecutor implements EvalExecutor {
  readonly where: ExecutionPlace = 'server';

  constructor(private readonly options: ServerExecutorOptions) {}

  async hardware(): Promise<HardwareInfo> {
    const { settings } = this.options;
    const instance = /^[a-z][a-z0-9_.:-]{0,63}$/.test(settings.instance) ? settings.instance : null;
    return describeHardware({
      dockerVersion: await this.options.docker.engineVersion().catch(() => 'unknown'),
      gpu: settings.evaluation.gpu,
      runnerInstance: instance,
    });
  }

  score(request: ScoringRequest): Promise<Score> {
    const { docker, settings, ...rest } = this.options;
    const input: ScoreEvaluationInput = {
      runId: rest.runId,
      tenantId: rest.tenantId,
      image: rest.image,
      treeDir: rest.treeDir,
      hiddenDir: rest.hiddenDir,
      basePatch: request.basePatch,
      agentPatch: request.agentPatch,
      task: request.task,
    };
    return scoreEvaluationRun({ docker, settings }, input);
  }
}
