"""公開レーダーのバケットの中身（ファイル名の形式・間隔・大きさ）を調べて results/discover.txt に書く"""
import boto3, botocore, datetime, os
from botocore import UNSIGNED
from botocore.config import Config
os.makedirs('out', exist_ok=True)
out = open('out/discover.txt', 'w')
def say(*a):
    print(*a); print(*a, file=out)
day = (datetime.datetime.utcnow() - datetime.timedelta(days=2)).strftime('%Y/%m/%d')
for region, bucket, prefixes in [
    ('eu-west-1', 'fmi-opendata-radar-geotiff', [day + '/', '']),
    ('eu-west-2', 'met-office-radar-obs-data', ['']),
]:
    s3 = boto3.client('s3', region_name=region, config=Config(signature_version=UNSIGNED))
    say('=====', bucket)
    for pre in prefixes:
        try:
            r = s3.list_objects_v2(Bucket=bucket, Prefix=pre, Delimiter='/', MaxKeys=60)
            say('-- prefix', repr(pre), 'dirs:', [c['Prefix'] for c in r.get('CommonPrefixes', [])][:40])
            for o in r.get('Contents', [])[:30]:
                say('   ', o['Key'], o['Size'])
        except botocore.exceptions.ClientError as e:
            say('error', pre, e)
    # 一段深く（最初の数ディレクトリ）
    try:
        r = s3.list_objects_v2(Bucket=bucket, Prefix=prefixes[0], Delimiter='/', MaxKeys=10)
        for c in r.get('CommonPrefixes', [])[:4]:
            r2 = s3.list_objects_v2(Bucket=bucket, Prefix=c['Prefix'], MaxKeys=15)
            say('-- under', c['Prefix'])
            for o in r2.get('Contents', [])[:15]:
                say('   ', o['Key'], o['Size'])
    except Exception as e:
        say('error deep', e)
