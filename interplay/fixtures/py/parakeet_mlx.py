"""A stand-in for parakeet-mlx (dictate's transcriber): every recording says the same invented sentence. No model, no
network. Found through PYTHONPATH by voice.py's worker, which runs with the python named in bin/parakeet-mlx."""


class _Result:
    text = "Please add a test for the retry, then push."


class _Model:
    def transcribe(self, _audio):
        return _Result()


def from_pretrained(_model_id):
    return _Model()
