# Reference

## Media at a Break

Select an audio or video clip and choose **Clip → Timing → On break**:

| Setting | What happens when playback reaches a Break |
| --- | --- |
| **Pause** | Audio holds at its current source position; video freezes on its current frame. |
| **Loop** | The selected source range repeats until playback continues. |
| **Finish** | The current playback finishes once, without looping or restarting. |

Audio has two separate loop controls:

- **Loop** repeats the selected source range for the clip’s set duration.
- **Loop indefinitely** repeats from the clip start to the sequence end. Its endpoint follows the sequence and cannot be resized.

For video, **Loop** repeats the selected source range while the clip is active. **On break** independently controls what happens at a Break.

## Sequence display, input, and ending

Open the **Sequence** inspector tab.

- Under **Presentation**, **Display area** chooses **Whole window** or **Canvas**.
- **Block input in this area** prevents input from reaching the Foundry area behind the sequence. Stagecraft buttons and playback controls remain usable.
- Under **Sequence ending**, choose:
  - **Automatic** to end with the sequence’s timed content.
  - **Fixed duration** to set when the sequence fades out.
  - **Hold manually** to stop at a final Break until you continue, fade, or stop playback.
  - **End with media** to end when the selected audio or video clip finishes.
- **Fade duration (s)** sets the sequence’s shared fade out.

## Viewer controls

- During shared playback, move the pointer over the sequence to reveal **Playback volume**. The local value (0–1) multiplies the clip's configured volume and does not change other viewers’ volume.
- In playback controls, **Leave on this device** exits playback on your client. It does not end the run for everyone.
- The GM can reopen **Playback control** from the Stagecraft scene-control tool. Closing that panel does not stop playback.

## Templates

Select a clip and open **Save as template** at the bottom of its Inspector. Enter a name, then choose **Save element** or **Save animation**. For an animation template, choose **In** or **Out** as its source phase.

Saved templates appear under **Templates** in the Library. Choose **Insert** to add an element template to the sequence, or select a clip and choose **Apply to In** or **Apply to Out** for an animation template.

## Troubleshooting

- **Prepare playback is unavailable:** save the sequence and clear any timing or field errors shown in the Inspector.
- **Start playback is unavailable:** check the participant statuses in **Playback control**. Participants need the module enabled and should be on the same Stagecraft version.
- **A Continue or Choice button is unavailable:** playback must be holding at an active Break, and the button must be visible at that time. Breaks at or beyond the sequence endpoint are inactive.
- **Media is missing or has no duration:** check the file path with Foundry’s file picker and use **Check duration again** in the clip Inspector. Make sure participating clients can load the file.
- **A choice card is not public:** check **Who can see the message** on the Choice button. An action error can be retried when playback reaches a Break.
- **No chat card during Preview or Play here:** these modes check appearance and local Break advancement. Test chat posting through prepared shared playback.
