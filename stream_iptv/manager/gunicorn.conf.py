# gunicorn settings for stream-iptv-manager (baked into the image).
# One process: sessions, player heartbeats, the segment cache and the credential
# token map live in memory. Threads carry concurrency; each proxied live .ts
# stream holds a thread for as long as it is watched.
bind = "0.0.0.0:5000"
workers = 1
worker_class = "gthread"
threads = 64
timeout = 120
graceful_timeout = 15
keepalive = 5
accesslog = "-"
errorlog = "-"
loglevel = "info"
