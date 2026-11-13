# homelab-iptv: IPTV manager, kiosk player and stream relay.
FROM python:3.10-alpine

RUN apk add --no-cache ffmpeg

COPY stream_iptv/manager/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

COPY stream_iptv /app/stream_iptv
COPY examples/playlist.example.yaml /app/defaults/playlist.yaml
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && cp /app/stream_iptv/manager/gunicorn.conf.py /etc/gunicorn.conf.py

ENV PYTHONUNBUFFERED=1
EXPOSE 5000
VOLUME /data
WORKDIR /app/stream_iptv/manager
ENTRYPOINT ["/entrypoint.sh"]
CMD ["gunicorn", "--config", "/etc/gunicorn.conf.py", "app:app"]
