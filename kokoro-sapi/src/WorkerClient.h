#pragma once
// Client side of the synthesis pipe (see WorkerProtocol.h). The 32-bit SAPI
// engine connects to the pipe served by the running kokoro-reader app, which
// performs synthesis in its webview (WebGPU) and returns PCM. No worker process
// is spawned: if the app isn't running, the pipe is absent and EnsureConnected
// fails (the host then gets no audio for that utterance).
#include <windows.h>
#include <string>
#include <vector>

class WorkerClient {
public:
    ~WorkerClient() { Close(); }

    // Connect to the app's pipe. Returns false if nothing is serving it
    // (i.e. the kokoro-reader app isn't running).
    bool EnsureConnected();

    // Result of reading one frame of the 'S' response stream.
    enum class FrameStatus { Data, End, Error };

    // Send the whole utterance for synthesis. The app splits it into chunks and
    // streams the PCM back frame by frame (read with ReadFrame). `rate` is the
    // host's rate-derived speed multiplier; the app owns the narrator voice and
    // folds in the user's speed itself (see WorkerProtocol.h). Returns false (and
    // closes the pipe) if the request can't be written.
    bool BeginSynth(const std::string& utf8Text, float rate);

    // Read the next frame of a stream started by BeginSynth. On Data, `outSamples`
    // holds that chunk's 24 kHz float PCM and `outGain` the user's current volume
    // (fresh per chunk). End marks a clean finish; Error a failed/broken stream
    // (the pipe is closed). The engine applies gain × host volume itself.
    FrameStatus ReadFrame(std::vector<float>& outSamples, float& outGain);

    void Close();

private:
    bool TryOpenPipe();

    HANDLE m_pipe = INVALID_HANDLE_VALUE;
};
