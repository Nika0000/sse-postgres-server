FROM oven/bun:1-alpine

RUN apk add --no-cache bash git sudo shadow postgresql-client

ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID

RUN if getent group $USER_GID > /dev/null 2>&1; then \
    EXISTING_GROUP=$(getent group $USER_GID | cut -d: -f1); \
    groupmod -n $USERNAME $EXISTING_GROUP || groupadd --gid $USER_GID $USERNAME; \
    else \
    groupadd --gid $USER_GID $USERNAME; \
    fi \
    && if getent passwd $USER_UID > /dev/null 2>&1; then \
    EXISTING_USER=$(getent passwd $USER_UID | cut -d: -f1); \
    usermod -l $USERNAME -d /home/$USERNAME -m $EXISTING_USER 2>/dev/null || useradd --uid $USER_UID --gid $USER_GID -m $USERNAME; \
    else \
    useradd --uid $USER_UID --gid $USER_GID -m $USERNAME; \
    fi \
    && echo "$USERNAME ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/$USERNAME \
    && chmod 0440 /etc/sudoers.d/$USERNAME

ENV PATH="/home/${USERNAME}/.bun/bin:${PATH}"
WORKDIR /workspace
USER $USERNAME
