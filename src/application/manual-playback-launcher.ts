import type { SequenceAudience, SequenceV1 } from '../domain/sequence.js';
import { withSequenceAudience } from '../domain/sequence-audience.js';
import { SequenceValidationError, validateSequence } from '../domain/validation.js';

export interface ManualPlaybackLauncherPorts {
  chooseAudience(sequenceName: string): Promise<SequenceAudience | null>;
  prepare(snapshot: SequenceV1): Promise<void>;
}

/** Each manual launch chooses its own audience without changing authored launch settings. */
export class ManualPlaybackLauncher {
  private preparing = false;

  constructor(private readonly ports: ManualPlaybackLauncherPorts) {}

  async prepare(sequence: SequenceV1): Promise<boolean> {
    if (this.preparing) return false;
    this.preparing = true;
    try {
      // Capture the draft before opening the asynchronous chooser.
      const snapshot = validateSequence(sequence);
      const audience = await this.ports.chooseAudience(snapshot.name);
      if (audience === null) return false;
      const launchSnapshot = withSequenceAudience(snapshot, audience);
      const chosenAudience = launchSnapshot.launch!.audience;
      if (chosenAudience.mode === 'selected' && chosenAudience.userIds.length === 0 && !chosenAudience.includeGM) {
        throw new SequenceValidationError('EMPTY_AUDIENCE',
          'Choose at least one player or include the GM before preparing playback.', 'sequence.launch.audience');
      }
      await this.ports.prepare(launchSnapshot);
      return true;
    } finally {
      this.preparing = false;
    }
  }
}
