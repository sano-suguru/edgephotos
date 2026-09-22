# 画面画像

README で使う画面画像の出どころです。

`timeline.png` は、ローカル開発環境（`vite dev`、Access と presigned URL は模擬）へ 32 枚を取り込んで撮ったものです。写っているのは [Lorem Picsum](https://picsum.photos/) が Unsplash の写真として配信しているもので、実在の家族写真ではありません。人物が特定できる写真は選んでいません。

取り込み前に EXIF を作り直し、撮影日時（`DateTimeOriginal`）だけを持たせています。元の EXIF に入っていた GPS などは残していません。
