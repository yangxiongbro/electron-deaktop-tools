# PC端 同步到 安卓端

## PC端 取消传输

安卓端同步记录出现了两次取消记录

PC端同步记录显示的是对方取消

![image-20261124222209958](D:\Projects\electron-deaktop-tools\需求\version-1.5.9-文件同步测试.assets\image-20261124222209958.png)



![image-20261124222249477](D:\Projects\electron-deaktop-tools\需求\version-1.5.9-文件同步测试.assets\image-20261124222249477.png)



## 安卓端 取消传输

第一次取消正常，取消之后再传新文件被自动取消

![image-20261124223003055](D:\Projects\electron-deaktop-tools\需求\version-1.5.9-文件同步测试.assets\image-20261124223003055.png)

![image-20261124222843123](D:\Projects\electron-deaktop-tools\需求\version-1.5.9-文件同步测试.assets\image-20261124222843123.png)



# 安卓端 同步到 PC端

## PC端 取消传输

PC端取消之后，安卓端无视取消直到发送完成，后又有两条取消同步记录

PC端的同步记录显示的是对方取消

![image-20261124223454109](D:\Projects\electron-deaktop-tools\需求\version-1.5.9-文件同步测试.assets\image-20261124223454109.png)

![image-20261124223440142](D:\Projects\electron-deaktop-tools\需求\version-1.5.9-文件同步测试.assets\image-20261124223440142.png)



取消之后再继续传新文件

安卓端的同步记录先显示了上一次取消的记录，然后才是本次文件的同步记录

PC端接收完一次后又重新接收，然后就停在1%，同步记录也没有记录本次传输

![image-20261124223907972](D:\Projects\electron-deaktop-tools\需求\version-1.5.9-文件同步测试.assets\image-20261124223907972.png)

![image-20261124223853548](D:\Projects\electron-deaktop-tools\需求\version-1.5.9-文件同步测试.assets\image-20261124223853548.png)





## 安卓端 取消传输

安卓端取消之后出现两条取消记录

PC端的传输状态就停留在取消的时候

![image-20261124224428838](D:\Projects\electron-deaktop-tools\需求\version-1.5.9-文件同步测试.assets\image-20261124224428838.png)

![image-20261124224423827](D:\Projects\electron-deaktop-tools\需求\version-1.5.9-文件同步测试.assets\image-20261124224423827.png)