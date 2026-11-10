#!/usr/bin/env python3
"""Local dictation for the dictate mod (macOS): ffmpeg records, parakeet-mlx transcribes.

    voice.py status                         {"ok", "macos", "ffmpeg", "parakeet"}
    voice.py start <config.json>            start recording, and a worker that loads the model meanwhile
    voice.py stop                           stop, transcribe: {"ok": true, "text": "..."}
    voice.py cancel                         stop both, drop the recording
    voice.py transcribe <audio> <config>    the same warm-worker path on a file (tests)
    voice.py worker <model> <ttl>           the worker itself, run by start with parakeet-mlx's python

The worker loads the model while you speak (and runs one pass over silence so MLX compiles its
kernels then), waits for the recording's path in a GO file, writes the text to OUT and exits.
It gives up after <ttl> seconds without a job and ffmpeg stops at maxSeconds: nothing stays
resident. Config (JSON, all optional): {"model": "...", "device": "0", "maxSeconds": 300}.
Only the standard library here; parakeet_mlx is imported by the worker alone.
"""
import json, os, shutil, signal, subprocess, sys, tempfile, time

STATE = os.path.join(tempfile.gettempdir(), f"herdr-dictate-{os.getuid()}")
WAV, GO, OUT = (os.path.join(STATE, n) for n in ("rec.wav", "go", "out.txt"))
PIDS, LOG = os.path.join(STATE, "pids.json"), os.path.join(STATE, "log.txt")
DEFAULTS = {"model": "mlx-community/parakeet-tdt-0.6b-v3", "device": "0", "maxSeconds": 300}
# Where Homebrew and uv put programs, for when the app's PATH lacks them.
EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", os.path.expanduser("~/.local/bin")]


def which(cmd):
    return shutil.which(cmd) or shutil.which(cmd, path=os.pathsep.join(EXTRA_PATH))


def parakeet_python():
    """parakeet-mlx's own tool venv python (its launcher's shebang), so the worker imports that install."""
    exe = which("parakeet-mlx")
    try:
        first = open(exe).readline() if exe else ""
    except OSError:
        return None
    return first[2:].strip().split(" ")[0] if first.startswith("#!") else None


def config(path):
    try:
        return {**DEFAULTS, **json.load(open(path))}
    except (OSError, ValueError, TypeError):
        return dict(DEFAULTS)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, TypeError):
        return False


def kill(pid, sig=signal.SIGTERM):
    try:
        os.kill(pid, sig)
    except (OSError, TypeError):
        pass


def rm(*paths):
    for p in paths:
        try:
            os.unlink(p)
        except OSError:
            pass


def pids():
    try:
        return json.load(open(PIDS))
    except (OSError, ValueError):
        return {}


def cached(model):
    hub = os.path.join(os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")), "hub")
    return os.path.isdir(os.path.join(hub, "models--" + model.replace("/", "--")))


def spawn_worker(cfg, ttl):
    py = parakeet_python()
    if not py:
        return None
    rm(GO, OUT)
    env = dict(os.environ)
    if cached(cfg["model"]):
        env.setdefault("HF_HUB_OFFLINE", "1")  # skip the hub round-trip on load; a first use downloads
    w = subprocess.Popen([py, os.path.abspath(__file__), "worker", cfg["model"], str(ttl)], env=env,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=open(LOG, "a"), start_new_session=True)
    return w.pid


def handover(audio, worker, timeout=180):
    """Gives the warm worker a file and waits for its text; None if it died first."""
    with open(GO + ".tmp", "w") as f:
        f.write(audio)
    os.replace(GO + ".tmp", GO)
    end = time.monotonic() + timeout
    while time.monotonic() < end and not os.path.exists(OUT) and alive(worker):
        time.sleep(0.03)
    if not os.path.exists(OUT):
        kill(worker)
        return None
    text = open(OUT).read()
    rm(OUT)
    return " ".join(text.split())


def log_tail():
    try:
        return open(LOG).read().strip().splitlines()[-1][-300:]
    except (OSError, IndexError):
        return ""


def status():
    return {"ok": True, "macos": sys.platform == "darwin", "ffmpeg": bool(which("ffmpeg")), "parakeet": bool(parakeet_python())}


def start(cfg):
    p = pids()
    if alive(p.get("ffmpeg")):
        return {"ok": True, "already": True}
    os.makedirs(STATE, exist_ok=True)
    rm(WAV, LOG)
    ffmpeg = which("ffmpeg")
    if not ffmpeg or not parakeet_python():
        return {"ok": False, "error": "ffmpeg or parakeet-mlx is missing"}
    ff = subprocess.Popen([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", f":{cfg['device']}",
                           "-ac", "1", "-ar", "16000", "-t", str(cfg["maxSeconds"]), "-y", WAV],
                          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=open(LOG, "a"), start_new_session=True)
    worker = spawn_worker(cfg, int(cfg["maxSeconds"]) + 120)
    with open(PIDS, "w") as f:
        json.dump({"ffmpeg": ff.pid, "worker": worker}, f)
    return {"ok": True}


def stop_recording():
    p = pids()
    ff = p.get("ffmpeg")
    if alive(ff):
        kill(ff, signal.SIGINT)  # lets ffmpeg finish the wav header
        for _ in range(50):
            if not alive(ff):
                break
            time.sleep(0.1)
        kill(ff, signal.SIGKILL)
    rm(PIDS)
    return p.get("worker")


def stop():
    worker = stop_recording()
    if not os.path.exists(WAV) or os.path.getsize(WAV) < 8000:  # under a quarter second
        kill(worker)
        return {"ok": False, "error": f"No recording. Does Herdr have microphone access? {log_tail()}".strip()}
    text = handover(WAV, worker)
    rm(WAV)
    return {"ok": True, "text": text} if text is not None else {"ok": False, "error": f"Transcription failed. {log_tail()}".strip()}


def cancel():
    kill(stop_recording())
    rm(WAV, GO, OUT)
    return {"ok": True}


def transcribe(audio, cfg):
    os.makedirs(STATE, exist_ok=True)
    rm(LOG)
    worker = spawn_worker(cfg, 300)
    if not worker:
        return {"ok": False, "error": "parakeet-mlx is missing"}
    text = handover(os.path.abspath(audio), worker)
    return {"ok": True, "text": text} if text is not None else {"ok": False, "error": f"Transcription failed. {log_tail()}".strip()}


def worker(model_id, ttl):
    from parakeet_mlx import from_pretrained
    import wave
    model = from_pretrained(model_id)
    warm = os.path.join(STATE, "warm.wav")
    with wave.open(warm, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(16000), w.writeframes(b"\0\0" * 16000)
    model.transcribe(warm)
    rm(warm)
    deadline = time.monotonic() + float(ttl)
    while time.monotonic() < deadline:
        if os.path.exists(GO):
            audio = open(GO).read().strip()
            rm(GO)
            text = model.transcribe(audio).text if audio else ""
            with open(OUT + ".tmp", "w") as f:
                f.write(text)
            os.replace(OUT + ".tmp", OUT)  # stop() waits for OUT; never a half-written file
            return
        time.sleep(0.05)


if __name__ == "__main__":
    op, args = (sys.argv[1] if len(sys.argv) > 1 else ""), sys.argv[2:]
    if op == "worker":
        worker(*args)
        sys.exit(0)
    ops = {"status": lambda: status(), "start": lambda: start(config(args[0] if args else "")), "stop": stop,
           "cancel": cancel, "transcribe": lambda: transcribe(args[0], config(args[1] if len(args) > 1 else ""))}
    if op not in ops:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    print(json.dumps(ops[op]()))
