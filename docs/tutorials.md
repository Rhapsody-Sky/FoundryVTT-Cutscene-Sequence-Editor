# Tutorials

As GM, open **Stagecraft → Open editor** from the scene controls.

## Reveal a chapter title

1. Choose **New sequence** and rename it. The starting **Cinematic bars** clip begins at zero and lasts **5 seconds**.
2. Add a **Title** from the Library. In **Clip → Content**, replace the sample text with a chapter name, such as “The Sunken Archive.”
3. Select the title and open **Clip → Timing**. Set **Start (s)** to **0.6**, choose **Fixed duration**, and set **Clip length (s)** to **4**. In **Clip → Animation**, choose **Fade** for both In and Out.
4. Select the bars and set their **Clip → Timing → Clip length (s)** to **4.6**. Leave **Sequence → Sequence ending** set to **Automatic**. Both elements now end together at 4.6 seconds.
5. Choose **Preview**, adjust the title’s position in the preview if needed, then save.

## Let each player read at their own pace

1. Add three **Title** clips for the passages and enter their text in **Clip → Content**. For a sample timeline, set their starts to **0**, **8**, and **16** seconds and each length to **8**, **8**, and **4** seconds.
2. Move the playhead to **7** seconds and choose **Break** in the Library. Add another Break at **15** seconds. Each marker now falls just before the next passage while the current passage is still visible.
3. Add a **Button** from the Library. In **Clip → Content**, leave **Button action** set to **Continue for this player** and give the button a clear label.
4. In **Clip → Timing**, set the button’s **Start (s)** to **0**, **Element duration** to **Fixed duration**, and **Clip length (s)** to **20** so it remains available at both Breaks. Leave **Sequence → Sequence ending** set to **Automatic**. Remove the starting bars if you do not want them in this scene.
5. Preview the sequence and test Continue at each Break. Save, prepare playback for the intended audience, and start the run from **Playback control**.

Adding a Button switches the sequence to per-player progression. When it reaches a Break, a player’s Continue button advances that player while the other viewers remain at their own Break.

## Post a choice to chat, then continue that player

1. Start a new sequence. Add a title asking “Open the sealed door?” and give it a **5-second** clip length. Place a **Break** at **3 seconds**. Return the playhead to zero and add one **Button** for each option; give both **Start (s) = 0**, **Element duration = Fixed duration**, and **Clip length (s) = 5**.
2. Select the first button. Under **Clip → Content**, set **Button action** to **Choice**. Create a **Question group** and name it **The sealed door**.
3. Set **Button label** to **Open it**, **Message to post in chat** to **I open the sealed door.**, and **Who can see the message** to **Everyone** or **GM only**.
4. Configure the second button as **Choice**, select the same **Question group**, set its label to **Leave it closed**, and enter **I leave the sealed door closed.** as its message. Position the buttons side by side in the preview so both remain visible and clickable.
5. Save, prepare playback for your players, and start the run from **Playback control**. At the Break, choosing an option posts its chat card and continues only that player’s sequence.

Each player can answer a question group **once per run**. Create a new group for each new question; use a Continue button for later reading stops.

Related guides: [Getting started](getting-started.md) · [Reference](reference.md).
